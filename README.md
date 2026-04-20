# CRM Automator — PestPac Edition

Universal CRM data entry automation. Drives PestPac from spreadsheet data.

---

## Part 1 — First-time setup (do this once)

### What you need
- A Windows PC
- Node.js 18 or newer — https://nodejs.org (click the LTS button)
- A free GitHub account — https://github.com/signup

---

### Step 1 — Install Node.js

1. Go to https://nodejs.org and click the big **LTS** button to download
2. Run the installer — click Next through everything, leave all defaults
3. Open **Command Prompt** (press Win+R, type `cmd`, press Enter)
4. Type `node --version` and press Enter — you should see something like `v20.11.0`

---

### Step 2 — Set up the project

1. Put the `crm-automator` folder somewhere permanent (e.g. `C:\Users\YourName\crm-automator`)
2. Open Command Prompt in that folder:
   ```
   cd C:\Users\YourName\crm-automator
   npm install
   ```
3. Test it runs:
   ```
   npm start
   ```
   The app opens. Close it when done.

---

### Step 3 — Create a GitHub repository

1. Go to https://github.com → click **+** (top right) → **New repository**
2. Name: `crm-automator-releases`
3. Set to **Private**
4. Click **Create repository**

---

### Step 4 — Configure the update URL

1. Open `src/main.js` in any text editor
2. Find line 8 and replace with your GitHub username:
   ```js
   const VERSION_URL = 'https://raw.githubusercontent.com/YOUR_USERNAME/crm-automator-releases/main/version.json';
   ```
3. Save the file

---

### Step 5 — Build the .exe

```
npm run build
```

Takes 2–5 minutes. Output: `dist/CRM Automator Setup 1.0.0.exe`

---

### Step 6 — Upload first release to GitHub

1. Your repository page → **Releases** → **Create a new release**
2. Tag: `v1.0.0` · Title: `v1.0.0 — Initial release`
3. Upload `CRM Automator Setup 1.0.0.exe`
4. Click **Publish release**

Then upload `version.json`:
1. Repository page → **Add file** → **Upload files**
2. Upload `version.json` → **Commit changes**

---

### Step 7 — Distribute

Send users `CRM Automator Setup 1.0.0.exe`. They run it, done.

---

## Part 2 — Publishing future updates

### Step 1 — Bump the version in two files

**`package.json`** line 3:
```json
"version": "1.1.0",
```

**`src/main.js`** line 6:
```js
const CURRENT_VERSION = '1.1.0';
```

### Step 2 — Build
```
npm run build
```

### Step 3 — New GitHub Release
1. Releases → **Draft a new release**
2. Tag: `v1.1.0`
3. Upload `CRM Automator Setup 1.1.0.exe`
4. Publish

### Step 4 — Update version.json
Edit the file and change the version and downloadUrl:
```json
{
  "version": "1.1.0",
  "downloadUrl": "https://github.com/YOUR_USERNAME/crm-automator-releases/releases/download/v1.1.0/CRM.Automator.Setup.1.1.0.exe",
  "notes": "What changed"
}
```

On GitHub: click `version.json` → pencil icon → paste new content → **Commit changes**.

Users get the update banner next time they open the app. One click installs it.

---

## Running generated scripts

```bash
npm install playwright
npx playwright install chromium
node crm-automation-playwright.js path/to/data.xlsx
```

---

## Credential security

Passwords are stored in **Windows Credential Manager** — never in plain text, never in the script, never sent anywhere. Retrieved at runtime by the OS vault.

---

## File structure

```
crm-automator/
├── src/
│   ├── main.js       ← Electron main, credential vault, auto-update
│   ├── preload.js    ← Secure IPC bridge
│   └── index.html    ← Complete UI
├── assets/icon.ico
├── version.json      ← Upload to GitHub to trigger updates
├── package.json
└── README.md
```
