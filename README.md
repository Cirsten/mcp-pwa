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
2. Open the `https://<project>.vercel.app` address on each device and **install** it. It is a full
   installable app (PWA): its own icon, its own window, and it works offline.
   * **Easiest:** press the red **Install app** button at the top of the app. Chrome and Edge show it as soon
     as the app can be installed, and it disappears once installed.
   * Windows, if no button: Chrome uses the install icon at the right of the address bar, or menu ⋮ → *Cast,
     save and share → Install page as app*. Edge uses menu ⋯ → *Apps → Install this site as an app*.
   * Android, if no button: Chrome menu ⋮ → *Add to Home screen → Install*.
   * Once installed, open it from the Start menu / taskbar (Windows) or the home screen (Android). Long-press
     (Android) or right-click (Windows) the icon for the shortcuts *Run pipeline* and *Files*. **Setup → This
     device** says whether you are in the installed app.
   * Updates install themselves: when a new version is on Vercel, the app picks it up the next time it is
     opened while online (close it fully and reopen if *App version* in Setup has not changed).

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
    Nothing changes on your devices. See *Secrets, passwords and settings* below for every reset step.

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

**Save to GitHub** (next to *Download parts zip*) puts the parts on GitHub so every device has them. GitHub keeps
**one file of each kind**, and saving a new set replaces it:

| Reading order | File in the data repo |
|---|---|
| Main order | `outputs/reading_parts_main.zip` |
| With alternate universes | `outputs/reading_parts_universes.zip` |
| Scenes | `outputs/reading_parts_scenes.zip` |

Whether the set was cut at your lists or automatically is in the commit message, and older versions remain in
the file's *History* on GitHub. On another device, open **Files → Saved reading parts → Save** to download one.
The button turns grey once that exact set is saved. The parts never go into `pre2017/` or `post2017/`, where the
pipeline would read them back in as your own lists.

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

## Secrets, passwords and settings: how to recover, reset or revoke each one

Nothing secret is stored in either GitHub repository. Everything secret is in one of three places: **GitHub**
(your account and the token), **Vercel** (the environment variables), or **the browser on each device**
(the passcode or token you typed into Setup). Nothing can be "recovered" from the app itself. Every secret is
reset at its source and then entered again where it is used.

### At a glance

| What | Where it lives | Can you see it again? | How to reset it |
|---|---|---|---|
| GitHub token (`github_pat_...`) | GitHub; a copy in Vercel `GITHUB_TOKEN` (or on a device in *Token on this device* mode) | **No.** GitHub shows it once | Regenerate on GitHub, then update Vercel (or each device) |
| App passcode | Vercel `APP_PASSCODE`; remembered by each device's browser | In Vercel, unless you marked it *Sensitive* | Change it in Vercel, redeploy, enter it on each device |
| `GITHUB_REPO`, `GITHUB_BRANCH`, `GITHUB_SUBDIR` | Vercel environment variables | Yes, they are not secret | Edit in Vercel, redeploy |
| Repo / branch / folder (*Token on this device* mode) | each device's browser | Yes, in the Setup tab | Retype in Setup and press *Save and test* |
| GitHub account password / 2-factor codes | GitHub | No | github.com/password_reset, or your 2FA recovery codes |
| Vercel account login | Vercel (usually *Continue with GitHub* or email) | No | Sign in again with the same method; email sign-in sends a fresh link |

### GitHub token (`GITHUB_TOKEN`)
**Symptoms:** *Save and test* or *Check GitHub for updates* says **"GitHub 401 (token or passcode wrong /
expired)"** while the passcode is right; or **"GitHub 404 ... the token cannot see this repo"** after the repo
was renamed or the token was limited to another repo. Fine-grained tokens expire on the date you chose, and
GitHub emails you about a week before.

**It cannot be recovered.** GitHub only shows a token once. To get a working one:
1. github.com → your picture → **Settings → Developer settings → Personal access tokens → Fine-grained
   tokens**.
2. Either click the existing token (e.g. `mcp app`) and press **Regenerate token**, which keeps the same repo
   and permissions and lets you pick a new expiry; or **Generate new token** with: *Only select repositories*
   → your data repo, and *Repository permissions → Contents: Read and write*.
3. Copy the new `github_pat_...` value (it is shown once).
4. Put it where the app uses it:
   * **Token in Vercel mode:** Vercel → your app project → **Settings → Environment Variables** → `GITHUB_TOKEN` →
     **⋯ → Edit** → paste → **Save**. Then **Deployments → ⋯ (top deployment) → Redeploy**. Variables only take
     effect after a redeploy. Nothing changes on your devices.
   * **Token on this device mode:** on each device, **Setup** → paste into *Personal access token* → **Save and
     test**.

**If the token may have leaked** (pasted somewhere public, a device lost in *Token on this device* mode):
delete it straight away on the same GitHub page (**Delete**, or **Revoke** on older pages). It stops working
at once. Then make a new one as above. GitHub keeps the full history of your repo, so any unwanted change made
with a leaked token can be undone (repo → **Commits**).

### App passcode (`APP_PASSCODE`)
**Symptoms:** *Save and test* says **"Wrong passcode."**

**Forgot it:** Vercel → project → **Settings → Environment Variables** → `APP_PASSCODE` → click to reveal it.
If you marked it **Sensitive**, Vercel will not show it. Reset it instead:
1. `APP_PASSCODE` → **⋯ → Edit** → type a new passphrase → **Save**. (A Sensitive variable can also be
   deleted and added again with the same name.)
2. **Deployments → ⋯ → Redeploy.**
3. On each device: **Setup → Token in Vercel** → type the new passcode → **Save and test**.

**Lost or sold a device, or someone else knows the passcode:** change it as above. Every device still using the
old passcode is locked out at once. The GitHub token never left Vercel, so it does not need changing.

### `GITHUB_REPO`, `GITHUB_BRANCH`, `GITHUB_SUBDIR`
Not secret. Check or fix them in Vercel → **Settings → Environment Variables**, then **Redeploy**.
* `GITHUB_REPO` is `owner/name` exactly, e.g. `Cirsten/mcp-self-sorting`. Update it if you rename the repo or move
  it to another account, and make sure the token is allowed to see the new repo.
* `GITHUB_BRANCH` is normally `main`. `GITHUB_SUBDIR` is only needed if the data is in a subfolder; leave it
  out otherwise.
* **"Server mode is not set up"** means `GITHUB_TOKEN`, `GITHUB_REPO` or `APP_PASSCODE` is missing, or the
  project was not redeployed after adding them.
* **"No Vercel functions here"** means the app was opened from somewhere other than the Vercel project
  (for example a copied file). Open the `https://<project>.vercel.app` address.
* Tick **Production** (and **Preview** if you test branch previews) for each variable, or that deployment won't
  see it.

### Where each device keeps things, and how to wipe it
* The passcode (or the token, in *Token on this device* mode) and the repo settings are kept in that browser's
  storage for the app's web address.
* **Setup → Delete downloaded files** removes the downloaded repo files, saved dates and last results, but
  **keeps** the passcode/token, so the device stays connected.
* **To remove everything, the passcode or token included** (for example before giving a device away):
  * Windows (Chrome / Edge): open the app's address, click the icon left of the address → **Site settings →
    Delete data** (Chrome) / **Cookies and site permissions → Manage and delete cookies and site data → Delete**
    (Edge). Uninstall the installed app as well: Start menu → right-click *MCP Reading Order* → **Uninstall**.
  * Android (Chrome): ⋮ → **Settings → Site settings → All sites** → the app's address → **Delete / Clear &
    reset**. Remove the home-screen app: long-press its icon → **Uninstall** / **Remove**.
  * The safest step for a device you no longer have is to **change the passcode** (or delete the token, in
    *Token on this device* mode). That works without the device.
* **Forgotten gcd.db file:** **Forget** in the GCD card, then **Choose gcd.db...** again.

### The GitHub repo itself
* The data repo must stay **private**. Check under repo → **Settings → General → Danger Zone → Change
  visibility**.
* Every change the app makes is a normal commit, so anything can be restored from **Commits** (or **Branches**
  for old branches) on GitHub.
* `cache/dates.csv` is not secret. Delete it on GitHub to make the next run that has gcd.db match every comic
  again.

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
