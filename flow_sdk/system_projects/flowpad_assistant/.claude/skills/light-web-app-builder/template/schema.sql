-- The app's tables. Run on every start, so every statement must be safe to repeat:
-- CREATE TABLE IF NOT EXISTS for a new table. To change a table that already has
-- data, add a column with ALTER TABLE in app.py's migrate() instead.

CREATE TABLE IF NOT EXISTS items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
