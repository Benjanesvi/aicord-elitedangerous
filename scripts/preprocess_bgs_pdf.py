# pip install pypdf regex
from pypdf import PdfReader
import json, re, os, math

PDF_PATH = "data/bgsguide.pdf"
OUT_DIR = "data"
CHUNK_SIZE, OVERLAP = 900, 150

SYSTEM_PAT = r"LTT[- ]?\d{4,5}|[A-Z][a-z]+ Sector [A-Z0-9\- ]+|[A-Z][A-Za-z0-9\- ]{2,}"
FACTION_PAT = r"Black Sun Crew|Space Force|Oblivion Fleet|Jerome Archer|Alliance|Empire|Federation"
DATE_PAT = r"\b(20\d{2}-\d{2}-\d{2}|[A-Z][a-z]{2,9}\s+\d{1,2},\s+20\d{2})\b"

def clean(s): return re.sub(r"\s+"," ",s or "").strip()
def toks(s):
    s = re.sub(r"[^a-z0-9\s\-]"," ",(s or "").lower())
    return [t for t in s.split() if len(t)>2]

def chunk(text, page):
    text = clean(text)
    i, out = 0, []
    while i < len(text):
        end = min(i+CHUNK_SIZE, len(text))
        ext = text[end:end+120]
        m = re.search(r"[\.!\?]\s", ext)
        if m: end += m.end()
        out.append({"page":page, "text":text[i:end]})
        if end>=len(text): break
        i = end - OVERLAP
    return out

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    reader = PdfReader(PDF_PATH)
    chunks = []
    for p in range(len(reader.pages)):
        raw = reader.pages[p].extract_text() or ""
        for c in chunk(raw, p+1):
            t = c["text"]
            systems = list(set(re.findall(SYSTEM_PAT, t)))
            factions = list(set(re.findall(FACTION_PAT, t)))
            dates = list(set(re.findall(DATE_PAT, t)))
            chunks.append({
                "id": len(chunks),
                "page": c["page"],
                "systems": systems,
                "factions": factions,
                "dates": dates,
                "text": t
            })

    # build tiny IDF index
    df, docs = {}, []
    for c in chunks:
        ts = set(toks(c["text"]))
        docs.append(ts)
        for w in ts: df[w] = df.get(w,0)+1
    N = len(chunks)
    idf = {w: math.log((N+1)/(df[w]+1))+1.0 for w in df}

    json.dump(chunks, open("data/bgs_chunks.json","w",encoding="utf-8"), ensure_ascii=False)
    json.dump({"idf":idf,"N":N}, open("data/bgs_index.json","w",encoding="utf-8"), ensure_ascii=False)
    print(f"wrote {N} chunks")
if __name__ == "__main__":
    main()
