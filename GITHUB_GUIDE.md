# CRM Automator — GitHub Setup & Update Guide

---

## PART 1: First-time setup (do this once)

### Step 1 — Install the tools you need

1. Download and install **Node.js** from https://nodejs.org (choose the LTS version)
2. Download and install **Git** from https://git-scm.com
3. After installing, open a terminal (Command Prompt or PowerShell on Windows) and verify:
   ```
   node --version
   git --version
   ```
   Both should print a version number.

---

### Step 2 — Create a GitHub account and repository

1. Go to https://github.com and create a free account if you don't have one
2. Click the **+** button in the top-right → **New repository**
3. Name it something like `crm-automator-releases`
4. Set visibility to **Private** (recommended — only you can see it)
5. Check **"Add a README file"**
6. Click **Create repository**

---

### Step 3 — Set up the project on your computer

1. Unzip the `crm-automator.zip` file you downloaded
2. Open a terminal and navigate into the folder:
   ```
   cd path\to\crm-automator
   ```
3. Install dependencies:
   ```
   npm install
   ```
4. Test that it runs:
   ```
   npm start
   ```
   The app should open. Close it when satisfied.

---

### Step 4 — Connect the project to your GitHub repository

1. In your terminal (inside the crm-automator folder):
   ```
   git init
   git add .
   git commit -m "Initial release"
   ```
2. Go to your GitHub repository page, click the green **Code** button,
   copy the HTTPS URL (looks like: https://github.com/YOUR_USERNAME/crm-automator-releases.git)
3. Connect and push:
   ```
   git remote add origin https://github.com/YOUR_USERNAME/crm-automator-releases.git
   git branch -M main
   git push -u origin main
   ```

---

### Step 5 — Configure the auto-update URL in the app

1. Open `src/main.js` in any text editor (Notepad works)
2. Find line 8 which reads:
   ```
   const VERSION_URL = 'https://YOUR_HOST/crm-automator/version.json';
   ```
3. Replace it with your GitHub raw URL:
   ```
   const VERSION_URL = 'https://raw.githubusercontent.com/YOUR_USERNAME/crm-automator-releases/main/version.json';
   ```
   Replace `YOUR_USERNAME` with your actual GitHub username.
4. Save the file.

---

### Step 6 — Build the installer (.exe)

1. In your terminal:
   ```
   npm run build
   ```
2. Wait a few minutes — this downloads Electron and packages everything.
3. When done, find the installer at:
   ```
   dist\CRM Automator Setup 1.0.0.exe
   ```

---

### Step 7 — Create your first GitHub Release

1. Go to your GitHub repository page
2. On the right side, click **Releases** → **Create a new release**
3. Click **"Choose a tag"** → type `v1.0.0` → click **"Create new tag: v1.0.0"**
4. Set the Release title to: `v1.0.0 — Initial release`
5. Drag and drop your `CRM Automator Setup 1.0.0.exe` file into the "Attach binaries" area
6. Click **Publish release**
7. After it uploads, click on the `.exe` file in the release — copy the URL from your browser.
   It will look like:
   ```
   https://github.com/YOUR_USERNAME/crm-automator-releases/releases/download/v1.0.0/CRM.Automator.Setup.1.0.0.exe
   ```

---

### Step 8 — Create the version.json file

1. In the crm-automator project folder, you'll find a file called `version.json`.
   Edit it to match your release:
   ```json
   {
     "version": "1.0.0",
     "downloadUrl": "https://github.com/YOUR_USERNAME/crm-automator-releases/releases/download/v1.0.0/CRM.Automator.Setup.1.0.0.exe",
     "notes": "Initial release"
   }
   ```
2. Push this file to GitHub:
   ```
   git add version.json src/main.js
   git commit -m "Add version.json and update server URL"
   git push
   ```

---

### Step 9 — Distribute the app

Send the `CRM Automator Setup 1.0.0.exe` file to your users. They install it by
double-clicking. On next launch, the app will check your `version.json` for updates.

---

---

## PART 2: Pushing a future update

Do this every time you make changes and want to push them to users.

---

### Step 1 — Make your changes

Edit whatever files you need in the `src/` folder.

---

### Step 2 — Bump the version number in two places

**File 1: `package.json`** — change `"version": "1.0.0"` to the new version, e.g. `"1.1.0"`

**File 2: `src/main.js`** — change `const CURRENT_VERSION = '1.0.0';` to `'1.1.0'`

Version numbering convention:
- `1.0.0` → `1.0.1`  Small bug fix
- `1.0.0` → `1.1.0`  New feature added
- `1.0.0` → `2.0.0`  Major overhaul

---

### Step 3 — Build the new installer

```
npm run build
```

The new installer will be at: `dist\CRM Automator Setup 1.1.0.exe`

---

### Step 4 — Create a new GitHub Release

1. Go to your GitHub repository → **Releases** → **Draft a new release**
2. Tag: `v1.1.0`
3. Title: `v1.1.0 — [brief description of what changed]`
4. Attach: `CRM Automator Setup 1.1.0.exe`
5. Click **Publish release**
6. Copy the download URL of the new `.exe`

---

### Step 5 — Update version.json

Edit `version.json` in your project folder:
```json
{
  "version": "1.1.0",
  "downloadUrl": "https://github.com/YOUR_USERNAME/crm-automator-releases/releases/download/v1.1.0/CRM.Automator.Setup.1.1.0.exe",
  "notes": "What changed in this version"
}
```

---

### Step 6 — Push to GitHub

```
git add .
git commit -m "Release v1.1.0 — [what changed]"
git push
```

**That's it.** The next time any user opens the app, it will check this file,
see that `1.1.0` > their installed version, and show the update banner.
They click Install and the new version downloads and installs automatically.

---

## PART 3: Verifying it works

After pushing an update, you can verify:

1. Open your GitHub repository
2. Go to the **Raw** view of `version.json`:
   `https://raw.githubusercontent.com/YOUR_USERNAME/crm-automator-releases/main/version.json`
3. You should see the JSON with your latest version number
4. Open the app → click **Updates** in the top bar
5. If the version in `version.json` is higher than the installed version,
   the update banner should appear

---

## Quick reference — version update checklist

```
□ Make code changes in src/
□ Bump version in package.json
□ Bump version in src/main.js (CURRENT_VERSION)
□ npm run build
□ Upload new .exe to GitHub Releases
□ Copy the .exe download URL
□ Update version.json with new version + URL
□ git add . && git commit -m "Release vX.X.X" && git push
□ Verify raw version.json on GitHub shows new version
□ Test update prompt on an older install
```
