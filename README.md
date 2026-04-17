# Best Price Widget
# Hotel Price Comparison Widget

An embeddable React widget that hotels can paste into their direct-booking site
to show visitors they have the best price compared to OTAs (Booking.com,
Expedia, Trivago, Hotels.com, and any others you track).

The widget floats in a corner of the page, shows the direct-site price
prominently, lists OTA prices underneath with a "you save X" message, and
funnels the visitor to the hotel's own booking engine.

<p align="center"><em>One script tag. No backend. CSV from Google Sheets.</em></p>

---

## How it works

1. Hotel publishes a Google Sheet as CSV with one row per (date, room_id).
2. Widget fetches the CSV on load and filters by the visitor's selected dates
   and room.
3. Direct price shown prominently. OTA prices shown below with the delta.
4. "Reserve" button deep-links into the hotel's booking engine.

Everything runs client-side. No server, no database, no API keys.

---

## Quick start (hotelier)

Once you've deployed `widget.js`, `widget.css`, and `config.js` together to
your web host or CDN (all in the same directory), paste the following into
any page on your site:

```html
<div id="price-widget"></div>
<script src="/widget/config.js"></script>
<script src="/widget/widget.js"></script>
```

> **Order matters.** `config.js` must load before `widget.js`.
> **`widget.css` must sit next to `widget.js`.** The script fetches it by
> relative URL at runtime and injects it into Shadow DOM.

Then edit `config.js` to set your Google Sheet URL, room list, brand color,
and booking-engine link. That's the whole integration.

---

## The Google Sheet

### Setup

1. Create a Google Sheet.
2. Add a header row with these exact column names:

   | date       | room_id    | room_name      | direct | booking | expedia | trivago | hotels_com |
   | ---------- | ---------- | -------------- | ------ | ------- | ------- | ------- | ---------- |

3. One row per (date, room_id). Dates in `YYYY-MM-DD` format.
4. Prices as plain numbers (the widget handles both `1,234.56` and `1.234,56`).
5. `File → Share → Publish to web → select sheet → CSV → Publish`.
6. Paste the resulting URL into `config.js` as `csvUrl`.

### Adding more OTAs

Any column name **not** in the reserved set `{date, room_id, room_name, direct}`
is automatically treated as an OTA. Add an `agoda` column, a `kayak` column,
whatever you want — the widget will pick it up. Use the `channelLabels` map in
`config.js` to control display names (e.g. `hotels_com` → `Hotels.com`).

### Multi-night stays

For a stay of N nights, the widget sums the nightly price across each channel.
If a channel is missing data for any night in the range, it's shown as "Not
available" — we refuse to compare partial data (it would misleadingly
understate OTA totals and inflate the "savings" claim).

---

## Configuration reference (`config.js`)

| Key                | Type           | Description                                                                  |
| ------------------ | -------------- | ---------------------------------------------------------------------------- |
| `position`         | `'bottom-right'` \| `'bottom-left'` \| `'center-right'` \| `'center-left'`  | Where the widget floats. |
| `csvUrl`           | string         | Google Sheets CSV publish URL.                                               |
| `roomOptions`      | `{id, name}[]` | Rooms in the dropdown. `id` must match `room_id` in the sheet.               |
| `default_room_id`  | string         | Which room is selected on load.                                              |
| `reserveUrl`       | string         | Booking engine URL. Supports `{checkIn}`, `{checkOut}`, `{roomId}` tokens.   |
| `currency`         | ISO 4217       | `'EUR'`, `'USD'`, `'GBP'`, `'JPY'`, etc.                                     |
| `locale`           | BCP 47         | `'en-GB'`, `'fr-FR'`, `'de-DE'` — controls number & date formatting.         |
| `brandColor`       | hex string     | Primary accent. Button text auto-contrasts (WCAG luminance).                 |
| `logoUrl`          | string         | Optional. Falls back to `hotelName` if empty.                                |
| `hotelName`        | string         | Shown in the header when there's no logo.                                    |
| `channelLabels`    | `{col: label}` | Pretty names for OTA columns.                                                |

---

## Style isolation

The widget mounts into **Shadow DOM**. Host-page CSS can't reach inside, and
the widget's styles can't leak out. This matters because hotel marketing sites
often ship aggressive global resets (`* { box-sizing: border-box; }` is the
gentlest version; some use `* { all: revert; }`) that would otherwise destroy
the widget's layout. Shadow DOM sidesteps this entirely.

Fonts are loaded from Google Fonts inside the shadow root. The widget uses
Fraunces (serif, for prices) and Inter (sans, for UI). If your host page
blocks external font loads at the CSP level, vendor them locally and swap the
`@import` in `widget.css`.

---

## Development

```bash
npm install
npm run dev       # Vite dev server at :5173, auto-opens demo.html
npm run build     # Produces dist/widget.js + dist/widget.css + dist/config.js
```

### Project structure

```
├── src/
│   ├── embed.jsx       # Entry: finds #price-widget, attaches Shadow DOM, mounts React
│   ├── Widget.jsx      # The React component itself (pill + expanded panel)
│   ├── data.js         # CSV fetch, parse, nightly aggregation
│   └── widget.css      # Scoped styles (injected into shadow root)
├── public/
│   ├── config.js       # Template config hoteliers customize
│   ├── demo.html       # Standalone mock hotel page showing the widget
│   └── sample-sheet.csv  # 90-day × 4-room × 5-OTA sample data
├── scripts/
│   ├── postbuild.js    # Copies config.js and demo.html into dist/
│   └── gen-sample.mjs  # Regenerates sample-sheet.csv
├── vite.config.js      # Builds IIFE bundle, bundles React in
└── package.json
```

### Build output

```
dist/
├── widget.js       # ~140kB min (~45kB gzipped) — React + ReactDOM bundled
├── widget.css      # Injected via Shadow DOM at runtime (served as a sibling for CDN cacheability)
├── config.js       # Copy your production config here
├── sample-sheet.csv
└── demo.html
```

### Tech choices & what got dropped

- **papaparse** — originally spec'd but removed. Its UMD bundle carries a
  web-worker shim we don't use, adding ~100kB. The CSV shape here is
  constrained enough that an inline 30-line parser handles it correctly
  (quoted fields, escaped quotes, CRLF).
- **react-day-picker** — also dropped. It pulls date-fns locales and weighs
  ~80kB. Replaced with `MiniCalendar.jsx`, a ~120-line range picker that uses
  `Intl.DateTimeFormat` for localization.
- **React** stays bundled: requiring hoteliers to install React themselves
  defeats the whole "paste a script tag" integration.

---

## Design notes

A few decisions worth calling out:

- **Collapsed pill → expanded panel.** A sticky floating element that always
  shows a full comparison is visually heavy on a marketing page. The pill
  teases the direct price and the savings; the panel appears on click.
- **Savings computed vs. the cheapest OTA**, not the most expensive. If
  Booking.com is 10€ more and Expedia is 100€ more, we claim "save 10€ vs
  Booking.com" — overclaiming destroys trust.
- **Missing-data conservatism.** A channel missing any night of the stay is
  shown as "Not available" rather than imputed. Anything else risks the widget
  stating an OTA total that's actually less than reality.
- **React bundled in.** Adds ~40kB gzipped. The alternative — requiring
  hoteliers to install React themselves — is a non-starter for a paste-a-tag
  integration.

---

## License

MIT.



## Getting started

To make it easy for you to get started with GitLab, here's a list of recommended next steps.

Already a pro? Just edit this README.md and make it your own. Want to make it easy? [Use the template at the bottom](#editing-this-readme)!

## Add your files

* [Create](https://docs.gitlab.com/user/project/repository/web_editor/#create-a-file) or [upload](https://docs.gitlab.com/user/project/repository/web_editor/#upload-a-file) files
* [Add files using the command line](https://docs.gitlab.com/topics/git/add_files/#add-files-to-a-git-repository) or push an existing Git repository with the following command:

```
cd existing_repo
git remote add origin https://gitlab.com/d-edge/d-edge/das/dtp/best-price-widget.git
git branch -M main
git push -uf origin main
```

## Integrate with your tools

* [Set up project integrations](https://gitlab.com/d-edge/d-edge/das/dtp/best-price-widget/-/settings/integrations)

## Collaborate with your team

* [Invite team members and collaborators](https://docs.gitlab.com/user/project/members/)
* [Create a new merge request](https://docs.gitlab.com/user/project/merge_requests/creating_merge_requests/)
* [Automatically close issues from merge requests](https://docs.gitlab.com/user/project/issues/managing_issues/#closing-issues-automatically)
* [Enable merge request approvals](https://docs.gitlab.com/user/project/merge_requests/approvals/)
* [Set auto-merge](https://docs.gitlab.com/user/project/merge_requests/auto_merge/)

## Test and Deploy

Use the built-in continuous integration in GitLab.

* [Get started with GitLab CI/CD](https://docs.gitlab.com/ci/quick_start/)
* [Analyze your code for known vulnerabilities with Static Application Security Testing (SAST)](https://docs.gitlab.com/user/application_security/sast/)
* [Deploy to Kubernetes, Amazon EC2, or Amazon ECS using Auto Deploy](https://docs.gitlab.com/topics/autodevops/requirements/)
* [Use pull-based deployments for improved Kubernetes management](https://docs.gitlab.com/user/clusters/agent/)
* [Set up protected environments](https://docs.gitlab.com/ci/environments/protected_environments/)

***

# Editing this README

When you're ready to make this README your own, just edit this file and use the handy template below (or feel free to structure it however you want - this is just a starting point!). Thanks to [makeareadme.com](https://www.makeareadme.com/) for this template.

## Suggestions for a good README

Every project is different, so consider which of these sections apply to yours. The sections used in the template are suggestions for most open source projects. Also keep in mind that while a README can be too long and detailed, too long is better than too short. If you think your README is too long, consider utilizing another form of documentation rather than cutting out information.

## Name
Choose a self-explaining name for your project.

## Description
Let people know what your project can do specifically. Provide context and add a link to any reference visitors might be unfamiliar with. A list of Features or a Background subsection can also be added here. If there are alternatives to your project, this is a good place to list differentiating factors.

## Badges
On some READMEs, you may see small images that convey metadata, such as whether or not all the tests are passing for the project. You can use Shields to add some to your README. Many services also have instructions for adding a badge.

## Visuals
Depending on what you are making, it can be a good idea to include screenshots or even a video (you'll frequently see GIFs rather than actual videos). Tools like ttygif can help, but check out Asciinema for a more sophisticated method.

## Installation
Within a particular ecosystem, there may be a common way of installing things, such as using Yarn, NuGet, or Homebrew. However, consider the possibility that whoever is reading your README is a novice and would like more guidance. Listing specific steps helps remove ambiguity and gets people to using your project as quickly as possible. If it only runs in a specific context like a particular programming language version or operating system or has dependencies that have to be installed manually, also add a Requirements subsection.

## Usage
Use examples liberally, and show the expected output if you can. It's helpful to have inline the smallest example of usage that you can demonstrate, while providing links to more sophisticated examples if they are too long to reasonably include in the README.

## Support
Tell people where they can go to for help. It can be any combination of an issue tracker, a chat room, an email address, etc.

## Roadmap
If you have ideas for releases in the future, it is a good idea to list them in the README.

## Contributing
State if you are open to contributions and what your requirements are for accepting them.

For people who want to make changes to your project, it's helpful to have some documentation on how to get started. Perhaps there is a script that they should run or some environment variables that they need to set. Make these steps explicit. These instructions could also be useful to your future self.

You can also document commands to lint the code or run tests. These steps help to ensure high code quality and reduce the likelihood that the changes inadvertently break something. Having instructions for running tests is especially helpful if it requires external setup, such as starting a Selenium server for testing in a browser.

## Authors and acknowledgment
Show your appreciation to those who have contributed to the project.

## License
For open source projects, say how it is licensed.

## Project status
If you have run out of energy or time for your project, put a note at the top of the README saying that development has slowed down or stopped completely. Someone may choose to fork your project or volunteer to step in as a maintainer or owner, allowing your project to keep going. You can also make an explicit request for maintainers.
