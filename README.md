# MCP Reading Order — the app

An installable web app (PWA) for **Android and Windows** that runs the Marvel Chronology merge pipeline
(`run_pipeline.py` and friends) **inside the browser** and gives you the CSV results as a zip.

* The Python scripts, character pages, reading lists and universe pages live in **your private GitHub repo**
  (the "data repo", e.g. `your-name/mcp-data`).
* Each time you run, the app asks GitHub which files changed (by their git checksum) and downloads only those,
  so it always uses the latest script Claude wrote and the latest page or list you uploaded.
* Python runs on the device (Pyodide 0.27.7 = Python 3.12 with networkx, BeautifulSoup and sqlite3). The pipeline
  scripts are used **unchanged**. In tests, the results matched a normal desktop run byte for byte.
* The 6 GB GCD database never goes to GitHub. You pick it on the device when you want fresh cover dates. The app
  reads it piece by piece, never loading it all into memory. The resulting `dates.csv` is saved to the repo
  (`cache/`), so your phone can use those dates without the GCD file.
* Works offline after the first run, using the files already on the device.

## Two repositories

| Repo | Contents | Visibility |
|---|---|---|
| **mcp-data** | pipeline scripts, `char/`, `universes/`, `pre2017/`, `post2017/`, `aliases.csv`, `sources.csv`, `cache/` | **Private** (copyrighted pages, your lists) |
| **mcp-pwa** (this) | the app; deployed to Vercel | either |

Keep them separate. If the data sat in the app repo, Vercel would publish your saved pages on the web.

## Set-up (once)

### 1. Data repo
1. On github.com create a **private** repo, e.g. `mcp-data`.
2. Upload the contents of `mcp_pipeline_v6.zip` (unzipped) to it, plus your `char/`, `universes/`, `pre2017/`
   and `post2017/` files. The GitHub website takes 100 files / 25 MB per file per drag-and-drop. The app's
   **Files** tab can upload too.

### 2. A token for the app
GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token:
* Repository access: **Only select repositories** → `mcp-data`
* Permissions → Repository → **Contents: Read and write** (Metadata: read is added automatically)
* Pick an expiry, then copy the token (`github_pat_…`).

### 3. Deploy the app on Vercel
1. Put this folder in its own GitHub repo (`mcp-pwa`), then on vercel.com: **Add New → Project → Import** that
   repo. Framework preset: **Other**. No build command or output directory is needed. Click **Deploy**.
2. Open the `https://<project>.vercel.app` address on each device and **install** it:
   * Windows (Chrome or Edge): the *Install app* icon in the address bar, or menu → *Apps → Install*.
   * Android (Chrome): menu ⋮ → *Add to Home screen* / *Install app*.

### 4. Connect (Setup tab). Choose one:
* **Token on this device**: enter `your-name/mcp-data`, branch `main` and the token. The token is stored only
  in that browser. Do this on each device.
* **Token in Vercel**: the token stays on Vercel's servers and devices only need a passcode. In Vercel →
  Project → Settings → **Environment Variables** add:

  | Name | Value |
  |---|---|
  | `GITHUB_TOKEN` | the fine-grained token |
  | `GITHUB_REPO` | `your-name/mcp-data` |
  | `GITHUB_BRANCH` | `main` (optional) |
  | `GITHUB_SUBDIR` | only if the data is in a subfolder (optional) |
  | `APP_PASSCODE` | a long passphrase you choose |

  Then redeploy (Deployments → ⋯ → Redeploy) and choose *Token in Vercel* in the app with that passcode.

  **Token vs. passcode.** In this mode the app's Setup tab asks only for an **App passcode**. That box is
  *not* the GitHub token: it is the passphrase you saved in Vercel as `APP_PASSCODE`, shown as dots like a
  password.
  * The **token** (`github_pat_...`) is the real key to your GitHub repo. It stays in Vercel and never goes on
    your phone or PC.
  * The **passcode** lets a device use the app. The app sends it to Vercel, and Vercel uses the token only if
    the passcode matches. Someone who finds the app's web address can't reach your repo without it.
  * After **Save and test**, a green "Connected to <your repo> (main)" means the passcode was right and the
    token works. Each device remembers the passcode, so you enter it once per device. Enter it again only if
    you change `APP_PASSCODE` in Vercel or clear the browser's data.
  * "Using 0 B of storage" under *This device* just means nothing is downloaded yet. Go to the **Run** tab
    and click **Check GitHub for updates**.
  * When the token expires, make a new one on GitHub and replace `GITHUB_TOKEN` in Vercel, then redeploy.
    Nothing changes on your devices.

  Limits of this mode: one upload can't be bigger than about 3 MB, because Vercel caps a request at 4.5 MB.
  Upload bigger pages on github.com or switch to "Token on this device". Downloads of big files are not
  affected, because the app fetches them straight from GitHub with a short-lived link.

## Everyday use
1. **Run tab → Run pipeline.** It checks GitHub first ("Always check before a run"), then runs all 5 steps.
2. **Download zip**, or **Share…** on Android. The zip has every CSV the run produced plus `run_log.txt`.
3. If the run made new GCD dates, they are committed to `cache/` automatically (an option you can turn off).
   If the pipeline added rows to `aliases.csv`, you get a *Save to repo* link.

**Reading parts:** under the result, *Split into reading parts* cuts the order into numbered Excel lists like
your own (column A, one comic per row), for example `01 1961-1963 Birth of the Fantastic Four to Birth of the
Avengers.xlsx`. You choose:
* **Reading order:** the main order, the order with the alternate universes, or scenes (page ranges and
  flashbacks as their own rows).
* **Where to cut:** at the same story points as your numbered reading lists, which also gives each part its
  list's name; or automatically, at a big event about every N comics.

It runs `split_reading_order.py` from the data repo, so the repo needs pipeline v7 or later.

**When do I need gcd.db?** Only when the list of comics changed, meaning new or updated pages. The app warns you
when the saved dates are older than the comic list. On Windows Chrome/Edge it remembers the file between
sessions. On Android, pick it each time. To make it smaller first, run `python3 gcd_slim.py /path/to/gcd.db`
on a computer. That keeps only what the date step reads.

**Files tab**
* *Add or replace files*: choose the folder, pick the files, and they go into one commit. Re-uploading an
  identical file is skipped.
* *Refresh pages from chronologyproject.com*: the Vercel function downloads each page listed in `sources.csv`
  and commits it (as `char/<name>.html`) only when it changed. It waits 3 seconds between pages. If the site
  blocks automated downloads, you get an error; save the page from your browser instead. Add your own rows to
  `sources.csv` (`folder,name,url`) for the headline characters and universes.
* *Files on this device*: what the app will run with. You can save a copy of any file or delete it from the repo.

**Adding files on github.com instead:** that works just as well, and **the app needs no update for new or
changed files.** Before every run it checks GitHub, downloads only the new or changed files and drops deleted
ones. A script Claude changes in the data repo is picked up the same way. The only exception is a script that
needs a Python package the app does not include.

The scripts recognise files by name and type, so follow these rules (full details in the data repo's
`README.md` and in each folder's `README.md`):

| Folder | Rules |
|---|---|
| `char/` | Name must end in `.mht`, `.mhtml` or `.html`; a file with no ending is ignored. Letter pages are `a.mht`...`z.mht`, the Key is `key.mht`, and the headline pages are `captain-america`, `hulk`, `iron-man`, `mr-fantastic`, `scarlet-witch`, `spider-man`, `storm`, `sub-mariner` (`.mht`). **Update a page under exactly the same name**: rename the browser's `Marvel Chronology Project - ...` name first, or both copies are read and that character counts twice. A new character page may have any name. |
| `universes/` | Alternate-universe pages only, any name, with or without an ending. Replace under the same name. |
| `pre2017/`, `post2017/` | `.xlsx` or `.csv`, comics in column A. **Start the name with the next number** (e.g. `94 2024_ ...xlsx`): it sets the order for *Split into reading parts*, and the rest of the name becomes the part's name. No notes or `.txt` files: every `.xlsx`, `.csv` and `.txt` file is read as a list. |

After adding or changing **pages**, choose `gcd.db` on the next run so the new comics get cover dates (the app
warns you). New or changed reading lists don't need it.

## What runs where

```
 device (browser)                                     GitHub (private data repo)
 ├─ app.js     sync by git SHA, upload, results  <──>  scripts, char/, universes/, lists, cache/
 ├─ worker.js  Pyodide (Python 3.12)                    ▲
 │   └─ runner.py: runs run_pipeline.py; its           │  (optional) Vercel functions
 │      subprocess calls run in-process (runpy)         │   api/gh.js        token proxy (passcode)
 ├─ gcd.db     read lazily from your disk (WORKERFS)    │   api/mcp-fetch.js website page -> commit
 └─ IndexedDB  copy of the repo, last zip, dates
```

`runner.py` swaps `subprocess.run` for an in-process runner, so `run_pipeline.py` itself decides the steps.
When Claude changes the scripts in the data repo, the app picks the change up on the next sync with no app
update. The app only needs changing if a script starts using a module Pyodide doesn't have (anything beyond
the standard library plus networkx, bs4 and sqlite3), or tries to start another program.

## Limits to know
* **Speed and memory**: Python in the browser is slower than on a computer, often by 1.5–3×. Phones are slower
  still. The full data set takes minutes. Keep the app in the foreground on Android, because Chrome may pause
  a background tab. A browser tab can use at most about 4 GB, so a very large data set on a low-memory phone
  may fail. Use the Windows device for those runs.
* The GCD step reads the 6 GB file through the browser and is the slowest step. Use `gcd_slim.py` and only
  run it when the comic list changed.
* Stop cancels the run straight away. Nothing is committed for a stopped run.

## Files
`index.html`, `styles.css`, `app.js` (UI, GitHub sync, uploads), `worker.js` + `runner.py` (Python),
`sw.js` (offline cache), `manifest.webmanifest`, `icons/`, `api/` (Vercel functions), `vendor/` (Pyodide
0.27.7 and wheels, served from the app itself so nothing depends on a CDN). See `vendor/LICENSES.md`.
