# Licence position — why this stack is safe to resell

Checked against each project's actual `LICENSE` file via the GitHub API on
2026-09-18, not against blog summaries (which are frequently wrong — several
widely-cited posts list SadTalker and MuseTalk with the wrong licence).

| Component | Licence | Commercial resale |
|---|---|---|
| **MuseTalk** (lip sync) | **MIT** | ✅ README states explicitly: *"The code of MuseTalk is released under the MIT License. There is no limitation for both academic and commercial usage"* and *"The trained model are available for any purpose, even commercially."* |
| **Chatterbox** (voice clone TTS) | **MIT** (Resemble AI) | ✅ |
| **ffmpeg** | LGPL/GPL build-dependent | ✅ used as a separate binary, not linked |
| **Express / Node** | MIT | ✅ |

GitHub's API reports MuseTalk as `NOASSERTION` — that is only because the file
appends a list of third-party dependency licences after the MIT text. The
licence itself is MIT.

## Deliberately avoided

| Component | Why not |
|---|---|
| **Wav2Lip** | **No licence file at all** — research use only. The single most-recommended lip-sync repo online and the most commonly misused commercially. |
| **HeyGen API** | Terms prohibit reselling and white-labelling by default. Negotiable, but not on standard plans. |
| **HunyuanVideo-Avatar** | Excellent quality, but the Tencent Community Licence **excludes the EU, UK and South Korea**, caps at 100M MAU, and requires passing use-restrictions through to your own customers contractually. Usable, but it makes your client contract more complicated. |
| **XTTS-v2 / Coqui** | Coqui Public Model Licence is non-commercial. |

## Third-party dependency check

MuseTalk pulls in `whisper`, `ft-mse-vae`, `dwpose` and `S3FD`, and its README
notes these must each comply with their own licences. Worth a re-read if this
grows beyond one client — dwpose in particular derives from work with
non-commercial clauses in some distributions.

## Obligations you actually have to meet

1. **Retain the MIT notices.** Keep the `LICENSE` files in the Docker image
   (they are — the repos are cloned intact, not vendored piecemeal).
2. **No warranty passthrough.** MIT disclaims warranty; your client contract
   should not promise more than you can stand behind.

## Not a licence issue, but the thing that actually gets people sued

Model licences are the easy part. The real exposure is **likeness and voice**:

- Get **written consent** from the person being cloned, covering both face and
  voice, and naming the permitted uses.
- State in the contract **who owns the trained voice/avatar** when the
  engagement ends, and whether you may reuse it.
- Several US states now have right-of-publicity and AI-likeness statutes with
  private rights of action. This is the litigation risk, not MIT compliance.
