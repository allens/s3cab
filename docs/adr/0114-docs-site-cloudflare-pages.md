# The docs site renders guide/ in place and Cloudflare Pages serves it

**Status:** accepted & implemented (2026-10-31); amended 2026-11-01 for the generated command
reference.

## Context

Every URL s3cab prints is `https://s3cab.plantegral.com/...` (CLAUDE.md → Coding conventions),
and a shipped binary, or an `exclude.txt` that `setup` wrote, freezes it for good. Until
2026-10-31 that domain was two 302 redirect rules: `/guide/<topic>` to the GitHub blob URL of
`guide/<topic>.md`, everything else to the repo. That kept the URLs alive but gave no site: no
search, no navigation, no previews, and no way to move a page except another redirect rule.

The pages themselves can't move. `guide/` ships in the npm tarball and is read on GitHub, so it
has to stay plain GitHub-flavoured markdown in that folder, and `/guide/<topic>` has to keep
meaning `guide/<topic>.md`.

## Decision

**The site renders README.md and `guide/*.md` where they are.** [site/](../../site/) is a
VitePress site whose source folder is the repo root, narrowed to README.md, `guide/` and
`site/`: `guide/<topic>.md` is `/guide/<topic>` as it stands, and rewrites make the README the
home page and `guide/README.md` the `/guide/` index; nothing is copied. Each of these pages is
a real file, so search, edit links and the dev server's reload read the file the page comes
from, with no patch each. The site spells heading anchors the way GitHub does and points links
that leave the site at GitHub, so a page written for GitHub reads the same on both. The build fails on a link to a missing page or `#anchor`, which
makes CI's `docs` job the link check. (VitePress is pinned to an exact 2.0 alpha; the reason is in
`site/.vitepress/config.mjs`.)

**The command reference is generated, not rendered from a file.** `/commands/<name>`, one page
per command, and its index at `/commands/` are built at build time from the command registry
with `src/help.mjs`'s own helpers (`site/.vitepress/command-pages.mjs`), so a page can't say
anything `--help` doesn't, and nothing generated is committed to go stale. They live outside
`guide/`, which ships in the npm tarball as markdown a person wrote. The CLI prints none of these
URLs, but the README links every one, and the README ships in every tarball, so they are held to
the same rule as `/guide/<topic>`: a page that moves, or a command that is renamed, gets a
`_redirects` line. Having no file, these pages need the patches the guide's don't: search
and the edit link are told their source in `site/.vitepress/config.mjs`.

**Cloudflare Pages builds and serves it, through its own GitHub app**: production from `main`, a
preview for every other branch. This repo has no deploy job and holds no Cloudflare credential.
A deploy from GitHub Actions (`wrangler pages deploy`) would need an API token, and a Pages token
can't be scoped to one project: it could edit every Pages project in the account.

**The platform repo's Terraform owns the hosting; this repo owns the content.**
`terraform/site-s3cab-plantegral-com.tf` there holds the Pages project, its build settings (the
`docs:build` command, the `site/.vitepress/dist` output folder, `NODE_VERSION=26.10.0`), the
custom domain and its DNS: a proxied CNAME from `s3cab.plantegral.com` to `s3cab.pages.dev`. This
repo holds the build and any `_redirects`. Terraform never owns the site's content, or every
deploy would read as drift. Changing the build command, the output folder or the Node version
takes a matching change there.

**No redirect rule may match `s3cab.plantegral.com`.** A zone rule runs before Pages, so one rule
on that hostname takes the whole site off the air. Platform's `zone-plantegral-com.tf` says so.
`plantegral.com` and `www.plantegral.com` still 302 to the site.

## Consequences

- **A `guide/*.md` file can't be renamed or removed** without breaking a URL some install
  still prints. A page that has to move gets a line in `_redirects` (in the site's `public/`),
  which the domain serves as a real redirect for good.
- **The zone's SSL mode is strict.** With flexible, Cloudflare fetches the origin over HTTP, and
  `pages.dev` answers HTTP with a 301 to HTTPS, which risks a redirect loop.
- **The `docs-urls` workflow checks the live URLs daily**, since a hosting change in the
  platform repo is invisible from here. [scripts/docs-urls.mjs](../../scripts/docs-urls.mjs)
  fetches `/`, `/guide/` and each `/guide/<topic>` from the production domain. The list is
  built from `guide/`, and `npm test` fails on any site URL in `src/` that isn't on it.

Verified at the cutover: `/`, `/guide/` and all ten `/guide/<topic>` pages return 200 with no
redirect on `s3cab.pages.dev` and on `s3cab.plantegral.com`; `/guide/nope` returns the site's own
404; `http://` answers 301 to `https://`; and platform's plan shows no changes after the apply.
Platform commits `1c35764` (project) and `2da90bb` (domain, DNS and the rules' removal).

## Considered and rejected

- **GitHub Pages** — real redirects aren't possible, only meta-refresh stub pages, and there are
  no previews per branch. A moved page needs a real redirect for good.
- **S3 + CloudFront** — clean URLs and redirects need a hand-written CloudFront Function, and
  previews are do-it-yourself. The domain was already in Cloudflare.
- **An R2 bucket** — object storage, not a web host: it serves no `index.html` for a folder and
  no `exclude.html` for `/guide/exclude`.
- **Workers static assets** — Cloudflare's recommendation for new sites, but Pages gives a
  preview per branch out of the box and keeps the Git source and build settings in one Terraform
  resource. Moving later would change the deploy target, not the content.
- **A docs generator that wants its own content folder** — moving `guide/` there would break
  the npm tarball and the GitHub pages; copying it would give two sources to keep in step.
- **A dynamic route under `site/` that reads each guide page in** (the first build) — a page
  with no file of its own, so every VitePress feature that reads the page's file needed its
  own patch: search indexed nothing, the edit link mapped paths by hand, and `lastUpdated`
  would date the route template.
