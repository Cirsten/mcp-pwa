"""Runs the unchanged pipeline scripts (run_pipeline.py and friends) inside Pyodide.

The scripts are written for a normal computer: run_pipeline.py starts each step with
subprocess.run([sys.executable, "script.py", ...]).  A browser has no processes, so subprocess.run is
replaced by a function that runs the script in this same interpreter with runpy, with its own sys.argv,
working directory and a fresh copy of the pipeline's own modules - the same effect as a new process.
Nothing in the pipeline scripts has to change for the app, so a script Claude updates in the repo is
picked up on the next sync as it is.
"""
import builtins
import hashlib
import io
import json
import os
import runpy
import subprocess
import sys
import time
import traceback
import zipfile

WORK = "/work"


def _local_modules():
    return {f[:-3] for f in os.listdir(WORK) if f.endswith(".py")}


def _run_script(cmd, cwd=None):
    cwd = str(cwd or WORK)
    script, argv = str(cmd[0]), [str(c) for c in cmd]
    for name in _local_modules() & set(sys.modules):  # a "new process" sees freshly loaded modules
        del sys.modules[name]
    old_argv, old_cwd, old_path = sys.argv, os.getcwd(), list(sys.path)
    sys.argv = argv
    os.chdir(cwd)
    if cwd not in sys.path:
        sys.path.insert(0, cwd)
    code = 0
    try:
        runpy.run_path(os.path.join(cwd, script), run_name="__main__")
    except SystemExit as e:
        if e.code is None:
            code = 0
        elif isinstance(e.code, int):
            code = e.code
        else:
            print(e.code)
            code = 1
    except BaseException:  # noqa: BLE001 - report every failure as a non-zero exit like a real process
        traceback.print_exc()
        code = 1
    finally:
        sys.stdout.flush()
        sys.argv, sys.path[:] = old_argv, old_path
        os.chdir(old_cwd)
    return subprocess.CompletedProcess(cmd, code)


_real_run = subprocess.run


def _fake_run(args, *a, cwd=None, **kw):
    args = list(args)
    if args and (args[0] == sys.executable or str(args[0]).endswith(("python", "python3"))):
        return _run_script(args[1:], cwd)
    raise OSError(f"the app cannot start other programs: {args!r}")


def _no_input(prompt=""):
    raise RuntimeError("The app cannot answer questions typed at the keyboard. " + prompt.strip())


subprocess.run = _fake_run
builtins.input = _no_input


def _sha256(path, normalise=False):
    if not os.path.exists(path):
        return None
    with open(path, "rb") as f:
        data = f.read()
    if normalise:  # csv.writer writes \r\n: a file that only changed line endings has not really changed
        data = data.replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def snapshot():
    """sha256 of every file in the work folder (to report what the run changed)."""
    out = {}
    for root, _, files in os.walk(WORK):
        for f in files:
            p = os.path.join(root, f)
            out[os.path.relpath(p, WORK)] = _sha256(p, normalise=True)
    return out


_inputs_unchanged = set()  # repo files the run left as they were: not put in the results zip


def run(opts_json):
    opts = json.loads(opts_json)
    before = snapshot()
    argv = ["run_pipeline.py"]
    if opts.get("db"):
        argv += ["--db", opts["db"]]
    else:
        argv += ["--skip-dates"]  # no GCD file this run: keep the dates.csv we already have
    if opts.get("forceDates") and opts.get("db"):
        argv.append("--force-dates")
    if opts.get("skipUniverses"):
        argv.append("--skip-universes")
    if opts.get("mergeArgs"):
        argv.append("--merge-args=" + opts["mergeArgs"])
    if not os.path.exists(os.path.join(WORK, "run_pipeline.py")):
        print("run_pipeline.py is not in the repository - nothing to run.")
        return json.dumps({"code": 2})
    print("$ python3 " + " ".join(argv[0:1] + [a if " " not in a else repr(a) for a in argv[1:]]))
    t0 = time.time()
    code = _run_script(argv, WORK).returncode
    after = snapshot()

    state_path = os.path.join(WORK, ".pipeline_state.json")
    state = {}
    if os.path.exists(state_path):
        with open(state_path) as f:
            state = json.load(f)
    dates_made = before.get("dates.csv") != after.get("dates.csv") and after.get("dates.csv")
    if dates_made:
        state["dates_generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    state.pop("db_path", None)  # a path inside the app means nothing on another device
    with open(state_path, "w") as f:
        json.dump(state, f, indent=2)
    entries_hash = _sha256(os.path.join(WORK, "entries.csv"))
    dates_stale = bool(after.get("dates.csv")) and state.get("entries_hash") not in (None, entries_hash)
    changed = sorted(p for p, h in after.items() if p in before and before[p] != h
                     and not p.startswith(".") and "/" not in p)
    _inputs_unchanged.clear()
    _inputs_unchanged.update(p for p, h in before.items() if after.get(p) == h and p != "dates.csv")
    created = sorted(p for p in after if p not in before and "/" not in p)
    return json.dumps({
        "code": code, "seconds": round(time.time() - t0, 1), "datesMade": bool(dates_made),
        "datesStale": dates_stale, "hasDates": bool(after.get("dates.csv")),
        "changedInputs": changed, "created": created,
    })


def make_zip(log_text, zip_name):
    """Every CSV the run left in the work folder, plus the run log, as one zip."""
    buf = io.BytesIO()
    names = sorted(f for f in os.listdir(WORK) if f.lower().endswith(".csv") and f not in _inputs_unchanged)
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in names:
            z.write(os.path.join(WORK, f), f)
        z.writestr("run_log.txt", log_text)
    data = buf.getvalue()
    with open("/tmp/" + zip_name, "wb") as f:
        f.write(data)
    return json.dumps({"files": names, "size": len(data)})


def split(opts_json):
    """Cut the last run's reading order into numbered parts (split_reading_order.py) -> zip in /tmp."""
    opts = json.loads(opts_json)
    if not os.path.exists(os.path.join(WORK, "split_reading_order.py")):
        print("split_reading_order.py is not in the repository - add it (pipeline v7) and check GitHub again.")
        return json.dumps({"code": 2})
    with zipfile.ZipFile("/tmp/last_results.zip") as z:  # the last run's CSVs, on top of the repo files
        for name in z.namelist():
            if name.lower().endswith(".csv") and "/" not in name:
                z.extract(name, WORK)
    out = "/tmp/" + opts["zipName"]
    argv = ["split_reading_order.py", "--source", opts.get("source", "main"), "--mode", opts.get("mode", "lists"),
            "--size", str(int(opts.get("size") or 300)), "--out", out]
    print("$ python3 " + " ".join(argv[:-2]))
    code = _run_script(argv, WORK).returncode
    names = []
    if code == 0 and os.path.exists(out):
        with zipfile.ZipFile(out) as z:
            names = [n for n in z.namelist() if n.endswith(".xlsx")]
    return json.dumps({"code": code, "parts": names})
