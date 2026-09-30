# Putting Alka Vida on the web

For testing it somewhere other than the office machine — so a customer can
reach the portal from their phone, an invitation link actually works when it
lands in somebody's inbox, and more than one person can be in the system at
once.

None of that can be tested on `localhost`. That is the whole reason for this.

Written for Evert, but complete enough to hand to whoever sets the server up.

---

## Four things that will bite you

Read these before choosing a host. Each one has stopped a deployment dead.

**1. Node 24 or newer. Not negotiable.**
The code runs TypeScript directly, without a build step, using Node's own
type-stripping. That feature does not exist before Node 22 and this codebase
targets 24. On Node 20 the server will not start at all — it will fail on the
first `.ts` import with a syntax error. Check the host offers Node 24 before
paying for anything.

**2. Use a real PostgreSQL database, not the built-in one.**
On the office machine, Alka Vida keeps its data in a folder
(`packages/api/.data`) using an embedded database called PGlite. That is
perfect for one person on one computer and wrong for a web host, for two
reasons: most hosts wipe the disk on every redeploy, so your data would
vanish the next time anything changed; and PGlite allows exactly one
connection, so nothing can ever be scaled or inspected alongside it.

Set `DATABASE_URL` to a managed PostgreSQL database and the application
switches over with no code change. Every host below offers one.

**3. One instance. Only ever one.**
Do not turn on autoscaling or run two copies. Standing orders are raised on a
timer inside the running process; a second copy is a second timer. The work
is written to be safe if it happens twice, but there is no reason to find out.

**4. HTTPS, from the first day anyone else uses it.**
Customers set their password by clicking an emailed link. Over plain `http://`
that password crosses the internet readable by anyone between them and the
server. Every host below terminates HTTPS for you at no extra cost — just use
the `https://` address they give you, not the bare IP.

---

## Choosing a host

You need: Node 24+, a PostgreSQL database, a disk that survives restarts (or
Postgres, which makes the disk irrelevant), and a process that stays running
rather than sleeping.

| Host | Fits | Watch out for |
|---|---|---|
| **Render** | Web Service + their managed Postgres. Straightforward, generous enough for testing. | The free tier sleeps after inactivity — the first request after a quiet spell takes ~30 seconds. Fine for testing, not for customers. |
| **Railway** | Same shape, slightly simpler setup. Postgres is one click. | Usage-billed rather than a flat free tier. |
| **Fly.io** | Good if you want the server physically closer to Jamaica. | More moving parts; you write a config file. |
| **A plain VPS** (DigitalOcean, Linode, Contabo) | Full control, cheapest at small scale. You could even keep the built-in database here, since the disk is yours. | You maintain it — updates, HTTPS certificates, restarting after reboot. Only sensible if somebody is comfortable on a Linux command line. |

For **testing**, Render or Railway. Decide about the real home later; nothing
here locks you in, because the data lives in standard PostgreSQL.

---

## Setting it up

### 1. Get the code onto the host

The repository is local-only at the moment — it has no GitHub remote. Hosts
deploy from a Git repository, so you will need to push it to one first
(GitHub, GitLab, Bitbucket — all have free private repositories). **Make it
private.** It is your business's operating system.

Branch to deploy: **`operations-fixes`**, not `master`. `master` holds only
the very first commit.

### 2. Tell the host how to build and start it

```
Build command:  npm ci && npm run build -w @alka/web
Start command:  npm start -w @alka/api
```

The build step matters: the browser side of the app is compiled into
`packages/web/dist`, and that folder is deliberately not stored in the
repository. Skip the build and you get a server with no screens.

### 3. Set the environment variables

These replace the `Alka Vida settings.txt` file used on the office machine.
A real environment variable always wins over that file, so a host is
configured the proper way.

**Required:**

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | The connection string from your host's Postgres | Otherwise it writes to a disk that will be wiped |
| `JWT_SECRET` | A long random phrase, 16 characters minimum | Signs the tokens that keep people signed in |
| `PORTAL_URL` | `https://your-address` | **The single most common mistake.** Invitation and password links are built from this. Leave it unset and every link you email says `localhost:3001`, which on a customer's phone means *their* phone. The link will look fine and work for nobody. |
| `NODE_ENV` | `production` | Switches off development conveniences |

> Setting `NODE_ENV=production` *without* `JWT_SECRET` makes the server refuse
> to start, deliberately — it will not fall back to something guessable. If it
> won't boot, that is the first thing to check.

**Strongly recommended:**

| Variable | Value | Why |
|---|---|---|
| `CORS_ORIGIN` | `https://your-address` | Defaults to accepting any origin, which is convenient locally and too open once the address is public |

**Optional:**

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3001` | Most hosts set this themselves — leave it alone unless told otherwise |
| `BUSINESS_TIMEZONE` | `America/Jamaica` | Which day an invoice is dated. **Leave this alone.** The host's own clock is almost certainly UTC, and changing it would date evening orders a day ahead |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | The mail account invoices and statements are sent from. Gmail and Google Workspace need a 16-character *app password*, not the ordinary one |
| `MAIL_FROM` | `SMTP_USER` | What customers see in the From line |
| `LOG_LEVEL` | `warn` | Set to `info` while diagnosing something |

---

## Before you give anyone the address

The first start on an empty database **seeds sample data** — a few practice
customers, and four shared logins whose passwords are printed on the sign-in
page:

```
admin@alkavida.jm    / admin1234
office@alkavida.jm   / office1234
driver@alkavida.jm   / driver1234
ap@bluemountain.jm   / portal1234
```

That is exactly right for a machine on your desk and **completely wrong for a
public address**. Anybody who finds the URL is an administrator.

So, in this order, the moment it is up:

1. Sign in as `admin@alkavida.jm`.
2. Go to **Logins** and create a real administrator account for yourself, with
   a password you choose.
3. Sign out. Sign back in as yourself.
4. Go back to **Logins** and **withdraw access** for all four seeded accounts.
   They are never deleted — every action in the system is signed by whoever
   did it, and removing a login would take that history with it. Withdrawing
   access takes effect immediately, on every request, not when a token
   expires.

Until step 4 is done, treat the address as secret.

---

## The company logo

`Alka Vida logo.png` is not in the repository — deliberately. It is your
property, it changes without the software changing, and a placeholder
committed there would eventually go out on a real customer's statement.

Without it, invoices and statements fall back to the wordmark set in type,
which looks perfectly respectable. If you want the real logo on documents
from the hosted copy, upload the file to the application's root folder on the
server. On hosts with no persistent disk you would need to commit it, which
is a reasonable exception to make in a **private** repository.

---

## What to actually test once it is up

These are the things that cannot be tested on the office machine — the reason
for doing any of this:

- [ ] **Open it on your phone**, over mobile data with wifi off. Confirms it
      is genuinely reachable and not just on your home network. Check the
      phone layout while you are there.
- [ ] **Invite a customer and click the link from a different device.** This
      is what `PORTAL_URL` exists for. If the link says `localhost`, that
      variable is wrong.
- [ ] **Have someone else sign in at the same time as you** and both place an
      order. Never possible on one machine.
- [ ] **Send a statement and an invoice by email** to an address you can
      check. Needs the SMTP settings; without them the app still produces the
      PDF for you to attach yourself.
- [ ] **A real customer places a real order through the portal** — the whole
      point of hosting it.
- [ ] **A driver works a round from their own phone** while you watch the
      office screen update.
- [ ] Leave it overnight and check in the morning that **standing orders were
      raised** while nobody was signed in.

---

## Moving data, and starting clean

The hosted copy starts with its own empty database. Your office machine's
test data does not come with it, and for testing that is usually a good thing
— you get a clean system and the office keeps working untouched.

Two notes:

- **The two are entirely separate.** An order placed on the hosted copy does
  not appear on the office machine, and the reverse. Do not run both as though
  they were one business.
- **`Reset Alka Vida data.bat` is not a go-live tool.** It wipes back to
  *sample* data, which is not the same as an empty system ready for real
  trading. A proper "start clean" — clears trading history, keeps your
  products, pricing, suppliers, zones and employees — has been discussed and
  not yet built.

---

## When something goes wrong

**It will not start at all.**
Check the Node version first — anything below 24 fails immediately on a `.ts`
import. Then check `JWT_SECRET` is set, since `NODE_ENV=production` without it
is a deliberate refusal to boot.

**Screens are blank, or you get "not found" everywhere.**
The build step was skipped. `npm run build -w @alka/web` must run before the
server starts, or `packages/web/dist` does not exist.

**Invitation links point at `localhost`.**
`PORTAL_URL` is unset or wrong. Fix it and re-send the invitation — issuing a
new one stops the old link working, which is the intended behaviour.

**Data disappeared after a deploy.**
`DATABASE_URL` was not set, so it wrote to the host's temporary disk. Set it
and start again. Nothing is recoverable from the wiped disk.

**Everything is dated a day early or late.**
`BUSINESS_TIMEZONE` was changed, or the host overrode it. It must be
`America/Jamaica`.

**It is very slow on the first click after a quiet period.**
The free tier went to sleep. Expected on Render's free plan; the fix is a paid
plan, not a code change.

---

## One thing to keep in mind

Hosting this makes it reachable by anyone who has the address — including
people who should not have it. It holds your customers' names, addresses,
phone numbers and what they owe you.

For testing, that is a manageable risk as long as you withdraw the seeded
logins straight away and keep the address to people you have chosen. Before
real customers use it in earnest, it is worth someone looking at backups
(your host's Postgres will do automatic ones — check they are actually
switched on) and at who holds an administrator login.

---

*Alka Vida — 1506 Investments Limited. See `HANDOFF.md` for what the system
does and the rules it must not break.*
