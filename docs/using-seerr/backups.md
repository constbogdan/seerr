---
title: Backups
description: Understand which data you should back up.
sidebar_position: 4
---

# Which data does Seerr save and where?

## Settings

Most configuration from the **Settings** panel—including provider credentials,
notification settings, and Servarr connections—is stored in `settings.json` in
the Seerr data folder. Some related application state and presentation metadata,
including Storage Root names, colors, and Animation designations, is stored in
the database. Back up and restore the complete configuration directory and the
database as one recovery set.

## User Data

Apart from the settings, all other data—including user accounts, media requests, blocklist etc. are stored in the database (either SQLite or PostgreSQL).

# Backup

### SQLite

If your backup system provides an application-consistent filesystem snapshot
(such as Kubernetes with Volsync), you can back up the Seerr data folder
directly. Otherwise, stop Seerr before copying the complete `config` folder.
Never let two Seerr processes or containers access the same SQLite database.

For advanced users, it is possible to back up the database without stopping the
application by using the [SQLite CLI](https://www.sqlite.org/download.html).
Run the following command to create a consistent online backup:

```bash
sqlite3 db/db.sqlite3 ".backup '/tmp/seerr_db.sqlite3.bak'"
```  

Then copy `/tmp/seerr_db.sqlite3.bak` to your backup location. Also copy the
configuration files needed by that database—especially `settings.json` and any
deployment manifest—into the same versioned backup set. Verify the backup with
`PRAGMA quick_check` before relying on it.

### PostgreSQL

You can back up the `config` folder and dump the PostgreSQL database without stopping the Seerr application.

Install [postgresql-client](https://www.postgresql.org/download/) and run the following command to create a backup (just replace the placeholders):

:::info
Depending on how your PostgreSQL instance is configured, you may need to add these options to the command below.

  -h, --host=HOSTNAME      database server host or socket directory

  -p, --port=PORT          database server port number
:::

```bash
pg_dump --format=custom -U <database_user> -d <database_name> -f /tmp/seerr_db.dump
```

# Restore

### SQLite

Stop Seerr before restoring. Restore the database and its matching configuration
files together. After restoring `db/db.sqlite3` and `settings.json`, the `config`
folder structure should look like this:

```
.
├── cache            <-- Optional
├── db
│   └── db.sqlite3
├── logs             <-- Optional
└── settings.json    <-- Required for a complete application restore
```

Run `PRAGMA quick_check` against the restored database, then start exactly one
Seerr application process.

### PostgreSQL

Install the [PostgreSQL client](https://www.postgresql.org/download/) and restore the PostgreSQL database using the following command (replace the placeholders accordingly):

:::info
Depending on how your PostgreSQL instance is configured, you may need to add these options to the command below.

  -h, --host=HOSTNAME      database server host or socket directory

  -p, --port=PORT          database server port number
:::

```bash
pg_restore --clean --if-exists -U <database_user> -d <database_name> /tmp/seerr_db.dump
```

Restore the matching `settings.json` and configuration files. The `config`
folder structure should look like this:

```
.
├── cache            <-- Optional
├── logs             <-- Optional
└── settings.json    <-- Required for a complete application restore
```

Once the database and configuration are restored and verified, start the Seerr
application. A custom-format dump is paired with `pg_restore`; if you choose a
plain SQL dump instead, restore it with `psql`, not `pg_restore`.
