# H.A.G. mobile publishing feed (Phase 2 pilot)

The app reads these public JSON feeds:

- `/app-content/api/v1/events.json` — approved public event records.
- `/app-content/api/v1/news.json` — approved public News stories.

Only content approved for publication belongs here. `news.json` is intentionally empty until H.A.G. approves its first official article. The prototype still displays clearly labeled demo articles.

**Temporary workflow:** Authorized editors can update the JSON files through their signed-in GitHub repository access after internal approval. Changes publish through GitHub Pages. We are building a separate, authenticated staff-friendly CMS for private drafts and one-click publishing later.

Never store athlete spotlight submissions, personal contact details, guardian forms, waivers, or unpublished photos in this publicly accessible repository.

### News item shape (sample data; do not publish verbatim)

```json
{
  "id": "a-unique-id",
  "publication_state": "draft",
  "category": "Programs",
  "title": "Example headline",
  "deck": "A short approved article summary.",
  "body": ["Paragraph one.", "Paragraph two."],
  "art": "H.A.G.\\nNEWS",
  "tone": "blue",
  "event_id": null,
  "published_at": null
}
```

**Drafts should be kept offline or in a private authenticated CMS, not committed here.** Only records explicitly marked `published` are served in the app. The current public preview still contains editorial examples for design review; those are not official News publications.

The proposed Supabase admin backend and RLS migration are part of the downloadable source package and are not deployed.
