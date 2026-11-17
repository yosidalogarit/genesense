# Essay Desk

A research desk for the writing section of the HSG Quốc gia English exam (IELTS Task 2 style, but longer).

1. **Paste the whole writing prompt** into the chat box.
2. Essay Desk works out what the debate is: the topic, the task type and the sub-issues. It writes search queries, which you can edit.
3. It searches **academic research** (OpenAlex, with Crossref as a fallback) and **editorials and quality journalism** (Tavily, The Guardian or Brave).
4. **Open any source inside the app.** Web pages and open-access PDFs are turned into a clean reading view. For paywalled papers you get the abstract.
5. **Highlight in 4 colours** (Argument, Evidence, Language, Counter-argument). You can attach a note to any highlight, or copy it as a quote with its citation.
6. **Notable phrases**: an AI list of reusable language (key claims, evidence, academic frames, collocations, topic vocabulary). Every phrase is **copied word for word**: the server checks each one against the article and drops anything paraphrased or invented. Click a phrase to jump to it, or highlight them all.
7. Keep an essay plan in **Notes**, then **export** everything (prompt, notes, highlights grouped by colour, phrases, citations) as Markdown.

## Run it

You need Node.js 20 or newer.

```bash
cd essay-desk
npm install
cp .env.example .env     # then add your keys (all optional)
npm start
```

Open <http://localhost:5178>.

To use it from a phone on the same Wi-Fi, set `HOST=0.0.0.0` in `.env`. Then open `http://<your-computer's-IP>:5178` on the phone; the layout switches to tabs.

## Keys (all optional, all have free tiers)

| What it unlocks | Key | Where |
| --- | --- | --- |
| Smart queries and Notable phrases | `GEMINI_API_KEY` (free) or `ANTHROPIC_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) / [Anthropic Console](https://console.anthropic.com/) |
| Editorials and journalism | `TAVILY_API_KEY` | [tavily.com](https://tavily.com) (free monthly credits) |
| Guardian articles with full text | `GUARDIAN_API_KEY` | [Guardian Open Platform](https://open-platform.theguardian.com/access/) (free developer key) |
| Alternative web search | `BRAVE_API_KEY` | [Brave Search API](https://brave.com/search/api/) |
| Avoids the shared academic search quota | `OPENALEX_API_KEY` | [openalex.org](https://openalex.org/) (free) |

**Recommended free setup:** Gemini, Tavily and Guardian keys.

With no keys at all, the app still works:
- queries come from keyword extraction;
- academic search runs;
- you can paste any link to read and highlight it.

The top bar shows what is switched on.

## Where your work is stored

Projects, opened articles, highlights and notes live in your browser's IndexedDB on your own device. Nothing is sent to a server except:
- the prompt, for analysis and search;
- article text, when you ask for Notable phrases.

Opened articles are cached, so they reopen offline.

Use **Export → Full backup (.json)** to move your work to another browser or computer, and **Restore backup…** to load it there.

## Keyboard

With text selected in the reader:

| Key | Highlight as |
| --- | --- |
| `1` | Argument |
| `2` | Evidence |
| `3` | Language |
| `4` | Counter-argument |

- `N` highlights the selection and opens a note.
- `Esc` closes the toolbar.
- `Ctrl` + `Enter` sends the prompt.

## Limits

- **Paywalled or JavaScript-only sites** (The Economist, NYT, FT, …) usually only give a preview. The reader says so and links to the original.
- **Scanned PDFs** without selectable text cannot be read.
- **Long sources:** Notable phrases reads only the first ~60,000 characters, and PDFs are cut off after 60 pages.

## Project layout

```text
server.js            Express server and API routes
lib/analyze.js       prompt → topic, task type, issues, queries (AI, with keyword fallback)
lib/search.js        OpenAlex, Crossref, Tavily, Brave, Guardian; merge and de-duplicate
lib/extract.js       fetch a page/PDF → clean reading HTML (Readability, DOMPurify, unpdf)
lib/phrases.js       AI phrase list + word-for-word verification
lib/llm.js           Gemini / Claude JSON calls
public/              the app (no build step): index.html, styles.css, js/*
public/js/textmatch.js  verbatim matching shared by server and browser
test/                node --test unit tests
```

Run the tests with `npm test`.
