---
id: 8edcadfe-73f7-4252-97ab-c1dd33acdb01
---

# תיקיית `electron/` — מבנה, זרימות, והשלבים הבאים

מסמך זה מתאר את המצב **בפועל** של תיקיית `electron/` בענף `FLOWPAD-2110`.
הוא משלים את [`electron.md`](electron.md) (סקירה כללית, ישנה יותר).

> **תיקון ל-`electron.md`:** שם כתוב שגרסת ה-Electron צריכה להתאים לגרסת ה-PyPI.
> זה **לא נכון**. הגרסאות בלתי תלויות: ה-desktop מותקן דרך electron-updater,
> והמנוע (`flowpad` ב-PyPI) מותקן ומתעדכן דרך `uv tool install`.

## 1. תמונת על

האפליקציה היא מעטפת דקה: ה-desktop (Electron) מתקין את **המנוע** (חבילת Python `flowpad`)
מ-PyPI באמצעות `uv`, מפעיל אותו על `http://localhost:9007`, וטוען אותו בחלון.

```
Electron (main.js)
 ├─ UvManager (uv-manager.js)  → uv → python → flowpad (PyPI)  → שרת על :9007
 ├─ electron-updater           → עדכוני desktop (GitHub releases)
 └─ BrowserWindow              → loading.html, ואז http://localhost:9007
```

## 2. מבנה התיקייה

### תהליך ראשי

| קובץ | תפקיד |
| --- | --- |
| `main.js` | נקודת הכניסה (אין exports). חלון, תפריט, deep links, IPC, עדכוני desktop, זרימת הפעלה/התקנה (`startApp`, `installAndStartBackend`), פאנל שגיאה. |
| `uv-manager.js` | המחלקה `UvManager`. הורדת `uv`, התקנה/שדרוג/התקנה מחדש של המנוע, בחירת Python, marker של התקנה חלקית, נפילה ל-WDAC, `checkForUpdatesInBackground`. |
| `preload.js` | גשר `contextBridge` לרנדרר. |
| `loading.html`, `loading-renderer.js` | מסך טעינה, התקדמות, ופאנל השגיאה (כולל "Share with us"). |

### מודולים קטנים (כל אחד עם קובץ `*.test.js`)

| מודול | תפקיד |
| --- | --- |
| `semver.js` | השוואת גרסאות. |
| `shutdown.js` | עצירה מסודרת של ה-backend. |
| `backend-wait.js` | המתנה לעליית השרת. |
| `flow-rs-keychain.js` | קריאת מפתחות מה-keychain. |
| `progress-watchdog.js` | שומר התקדמות: חלונות של 30 שניות, 3 חלונות שקטים רצופים = תקוע. מותנה ב-`canStall`, דגימה אסינכרונית, בטוח לחפיפה. |
| `update-restart.js` | `createRestartApplier` — "Restart now": עוצר את ה-backend, מתקין, ומתאושש אם ההפעלה נכשלה. |
| `update-plan.js` | זרימת העדכון המשולבת: `decideOffer`, `savePendingEngine`, `markPendingEngineConsented`, `planAfterDesktopUpdate`, `createReadyReminder`. |
| `startup-error.js` | `describeStartupFailure` ו-`summarizeOutput` — טקסט הפאנל ואילו צעדים להציג. |
| `support-bundle.js` | "Share with us": `collectLogs`, `buildSupportZip`, `buildMailtoUrl`, `redact`. |
| `zip-writer.js` | כתיבת zip ללא תלות חיצונית (`createZip`, `crc32`). |
| `log-redact.js` | הסתרת סודות בלוג: `redactUrl`, `redactLogMessage`, `installLogRedaction`. |
| `app-location.js` | זיהוי AppTranslocation והצעה להעביר ל-`/Applications` (macOS בלבד). |

### בנייה, חתימה והפצה

| נתיב | תפקיד |
| --- | --- |
| `electron-builder.json` | הגדרות בנייה. רשימת `files` היא **whitelist** — מודול חדש חייב להיכנס אליה, אחרת לא ייארז. קובצי `*.test.js` מוחרגים. |
| `electron-builder.config.cjs` | עוטף את ה-JSON. תחת `FLOWPAD_SIGNING=required`, `publisherName` מסוג placeholder נחשב חסר (`builder-config.test.js`). |
| `signing/` | `mac-sign.js`, `notarize.js`, `win-verify.js`, ומסמכי `LAUNCHER.md`, `SMARTSCREEN*.md`, `WINDOWS-SIGNING.md`. |
| `scripts/build-flow-rs.js` | בניית הבינארי `flow-rs`. |
| `winget/`, `store/STORE.md` | הפצה ב-winget ובחנויות. |
| `resources/`, `agentic-assets/`, `entitlements.mac.plist` | אייקונים, נכסים מצורפים, הרשאות macOS. |

### בדיקות והרצה

- `npm test` מריץ 14 קובצי בדיקה ברצף (ראו `package.json`).
- `main-update-flow.test.js` הוא בדיקת אינטגרציה שטוענת את `main.js` **האמיתי** עם stubs ל-electron,
  electron-updater, electron-log ו-UvManager, וחושפת פנימיים על ידי הוספה למקור בזמן הטעינה.
  נבדק בשלוש בדיקות מוטציה.
- הבדיקות של `uv-manager` לא מריצות את ה-installer האמיתי: `_runStreaming` מוחלף ב-stub, ושומר גלובלי זורק
  על כל פקודה עם `astral.sh` / `tool install` / `tool run`.
- CI: job בשם `electron-tests` ב-`.github/workflows/test.yml`. מקומית: hook בשם `electron-tests` ב-`.pre-commit-config.yaml`.
- ריפו השחרור `flowpad-desktop` (`.github/workflows/build-desktop.yml`): job `test-electron` מריץ `npm test`,
  הזהות נכתבת ב-sed ומאומתת, `win-verify.js release --publisher "Langware INC."`, והצעד
  "Verify baked auto-update config (app-update.yml)".

## 3. זרימות

### 3.1 הפעלה והתקנה ראשונה
1. `startApp` (ב-macOS, לא ב-dev) קורא קודם ל-`offerMoveToApplications`.
2. אם אין `uv` — `ensureUv` מוריד אותו (סעיף 4).
3. `installAndStartBackend` מתקין את המנוע: `uv tool install flowpad@latest|==X --python <pin> --force --compile-bytecode`.
4. ה-desktop ממתין לבריאות השרת, וטוען את החלון.
5. כשל מוצג בפאנל שגיאה מפורט, עם Retry / Share with us.

**בחירת Python:** ה-pin נלקח מהרצפה ב-`pyproject.toml` המצורף, ומועלה לפי `requires_python` של
הגרסה ב-PyPI (`pythonFloor`, `maxPythonVersion`, `_pythonPinForUpgrade`). זה מה שמונע את הכשל
"מנוע ≥0.2.173 דורש 3.11 ו-desktop ישן נעול על 3.10" עבור desktop חדשים.

### 3.2 עדכונים (זרימה חדשה)
- בדיקה כל 20 דקות (`UPDATE_CHECK_INTERVAL_MS`), דרך `checkPackageUpdateInBackground`.
- **desktop + מנוע חדשים יחד:** מסך אחד, "Update now / Later". הגרסה X של המנוע נשמרת ב-`pending-engine.json`.
  ה-desktop החדש, אחרי "Restart now" מאושר, מתקין בדיוק `flowpad==X` (`planAfterDesktopUpdate` ← `upgrade({version})`).
- **"Later":** תזכורת כל 90 דקות (`READY_REMINDER_MS`). אם האפליקציה נסגרת אחרי Later — יוצג הדיאלוג הרגיל של המנוע,
  ללא התקנה שקטה.
- **desktop חדש יותר** מרענן את X. דיאלוגי מנוע **מוחזקים** כל עוד עדכון desktop ממתין.
- **X שנמשך (yanked)** מוחלף בגרסה האחרונה (`_resolveEngineTarget`).
- רק עדכון מנוע: הדיאלוג הרגיל. רק עדכון desktop: הורדה ברקע וה-prompt "ready".
- electron-updater: `autoDownload=false`, `autoInstallOnAppQuit=true`, NSIS עם `oneClick:false`
  (`quitAndInstall` מטופל ב-`update-restart.js`), ההגדרה אידמפוטנטית (`updaterInitialized`).

### 3.3 התאוששות התקנה שנקטעה
`~/.flow/desktop-install-in-progress.json` נכתב לפני התקנה ונמחק בהצלחה.
`repairIfInterrupted` מתקן בהפעלה הבאה; `abortInstall` עוצר; אם ה-watchdog הרג את ההתקנה
(`killedByGuard`) ה-marker **נשמר**. דיאלוג ב-`before-quit` מזהיר בזמן התקנה.

### 3.4 Watchdog והגבלות זמן (ערכים שאושרו)
| מה | ערך |
| --- | --- |
| חלון watchdog | 30 שניות, 3 חלונות שקטים רצופים = תקוע |
| הורדת `uv` — תקרת fallback (כשהאות לא מהימן) | 200 שניות (`_fallbackCapMs`) |
| `uv tool install` — תקרה קבועה | 240 שניות (`_toolInstallCapMs`), זהה ב-`upgrade()` / `reinstall()` |
| בריאות אחרי שדרוג | 240 בדיקות = 120 שניות (`POST_UPGRADE_HEALTH_CHECKS`) |
| דממה בלוג השרת | 60 בדיקות = 30 שניות (`LOG_STALL_CHECKS`) |

**אות ההתקדמות:**
- הורדת `uv`: TMPDIR פרטי + shim ל-`mktemp` (ב-macOS `mktemp -d` מתעלם מ-TMPDIR), עם אימות בזמן ריצה
  (`_installerHonorsTempDir`). ב-Windows נדרש `PSModulePath` משלו (`windowsPowerShellModulePath`) כי הורש מ-pwsh 7 שובר
  את powershell.exe 5.1.
- `uv tool install`: טביעת אצבע אסינכרונית של הרמה העליונה של `uv cache dir` ו-`uv python dir` (כולל dot-entries),
  ועוד גודל אסינכרוני של `<tool dir>/flowpad`. האמון באות נקבע בזמן ריצה, כשרואים את התיקיות זזות.
  סריקה מלאה לא נעשית: מטמון של 8GB לקח ~9 שניות סינכרוני.
- נמדד עם uv אמיתי: proxy איטי 300KB/s — ההתקנה הצליחה ב-407 שניות, ללא עצירה שגויה. רשת קפואה עם
  `UV_HTTP_TIMEOUT=900` — השומר עצר ב-180 שניות עם `stalled:true` וה-marker נשמר.

### 3.5 מדיניות מאבטחת אפליקציות (WDAC)
כש-`flow.exe` נחסם (`isPolicyBlockError`), השרשרת: launcher shim ← `uv tool run` ← python מה-venv (`PY_FLOW_ENTRY`).
אם הכול נחסם — שגיאת `policyBlocked`, והפאנל מסתיר צעדי שדרוג/אבחון שלא יעזרו.

### 3.6 סודות בלוג
`installLogRedaction(log)` נקרא לפני השורה הראשונה; `redactUrl` מופעל בכל מקום שכותב URL.
ב-Share: `support-bundle.redact` מכסה גם `fp_(live|test)_`.

### 3.7 Share with us
נשלח ל-`diagnosis@langware.ai`, נושא `Flowpad startup problem - YYYY-MM-DD`.
נכללים **רק** לוג ה-desktop החדש ביותר ולוג ה-server החדש ביותר. זה `mailto:` (מוגבל ל-1800 תווים)
וה-zip נוצר מקומית (`MAX_LOG_BYTES` = 2MB לקובץ).

### 3.8 AppTranslocation
ב-macOS, אפליקציה שרצה מתיקייה זמנית מקבלת הצעה אחת לכל גרסה לעבור ל-`/Applications`
(`app.moveToApplicationsFolder`). הסטטוס נשמר ב-`app-location-prompt.json`.

## 4. קבצי מצב ולוגים

| קובץ | מיקום |
| --- | --- |
| `desktop-version.json`, `app-location-prompt.json`, `pending-engine.json` | `app.getPath('userData')` |
| `desktop-install-in-progress.json` | `~/.flow/` |
| לוג desktop | `~/.flow/logs/main_desktop/<DDMonYYYY_HH_MM_SS>.log` |
| לוגי שרת/monitor | `~/.flow/instances/<FLOW_INSTANCE או prod>/logs/{server,monitor}` |

## 5. ערוצי IPC

- `handle`: capture-region, close-auth-window, copy-to-clipboard, get-app-version, get-backend-url,
  get-startup-logs, notify-attention, notify-os, open-auth-window, open-external, open-logs-folder,
  restart-backend, set-badge, share-logs, upgrade-flowpad.
- `on`: quit-app, set-menu-visible, unwatch-startup-logs, watch-startup-logs.
- `once`: retry-startup.
- אירועי `app`: activate, before-quit, open-url, second-instance, window-all-closed.

---

## 6. הערה: מה עוד צריך לממש (השלב הבא)

**לא מומש — ומסומן כך במכוון:**

1. **Rollback של מנוע שבור.** כיום יש רק *מסלול התאוששות* (marker + ניסיון חוזר), אין חזרה לגרסה קודמת.
   תכנון: גיבוי של תיקיית ה-instance, של `agentic-assets/` ו-`.flow/` בכל root, ושל `global/migrations`;
   שחזור כשהבריאות נכשלת בחלון ההפעלה הראשון. דורש פקודה בצד Python (`flow backup`).
2. **שער תאימות.** המנוע יפרסם `min_desktop_version`, וה-desktop לא ישדרג מנוע שדורש desktop חדש יותר.
3. **דליפת מפתח API בצד Python.** `flow_sdk/server/run.py` מריץ uvicorn עם `log_level="info"` ו-access log
   ברירת מחדל, ולכן ה-query string המלא של `/auth/login_callback` (כולל `flowpad-api-key`) נכתב ללוג השרת.
   נדרש filter על `uvicorn.access`. (הוכח עם uvicorn אמיתי.)
4. **לרוטט את 6 מפתחות `fp_live_`** שנחשפו בלוגי ה-desktop הישנים.
5. **`requires_python`** — כרגע מפורש רק `>=`. חסרים `~=`, `==` וגבולות עליונים.
6. **עדכון `uv` עצמו.**
7. **I13:** נתיב venv/tool מקודד במקום `uv tool dir`.
8. **I22:** קריאת keychain בלי timeout (שינוי כזה דורש אישור מפורש, לפי כללי הפרויקט).
9. **AppImage (U10):** unlink לפני `mv`, גיבוי ב-hardlink, preflight; ב-deb/rpm — `pkexec`.
10. **U8:** gating לפי `isUpdateAvailable`. וכן שאריות N10/N12/N13.
11. **אימות על מכונות אמיתיות:** מכונת WDAC, Electron + electron-updater ב-macOS וב-Windows,
    `moveToApplicationsFolder`. הבדיקות האוטומטיות משתמשות ב-stubs ולא מחליפות זאת.
12. **תחזוקת מסמכים:** להריץ `docit index` (`docs/index.md` נוצר אוטומטית ואסור לערוך אותו ידנית),
    ולתקן את הטענה השגויה ב-`electron.md`.
