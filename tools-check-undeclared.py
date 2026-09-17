# Guard: every locally-called helper must be declared somewhere in the same
# script. node --check cannot see this -- calling a function that does not exist
# is valid syntax and only throws at runtime, which is how three missing
# functions shipped and left the Activity rail blank.
import re, sys

BUILTINS = {
 'parseInt','parseFloat','isNaN','isFinite','setTimeout','setInterval',
 'clearTimeout','clearInterval','encodeURIComponent','decodeURIComponent',
 'getComputedStyle','requestAnimationFrame','cancelAnimationFrame',
 'structuredClone','queueMicrotask',
 # common method names that survive the lookbehind in multi-line chains
 'getDay','getHours','getMinutes','getTime','getFullYear','getMonth','getDate',
 'toISOString','toLocaleTimeString','toLocaleDateString','toLocaleString',
 'toFixed','toLowerCase','toUpperCase','getPropertyValue','getAttribute',
 'setAttribute','removeAttribute','querySelectorAll','querySelector',
 'addEventListener','removeEventListener','appendChild','removeChild',
 'createElement','getElementById','preventDefault','stopPropagation',
 'toLocaleUpperCase','localeCompare','startsWith','endsWith','includes',
 'padStart','padEnd','trimStart','trimEnd','charCodeAt','fromCharCode',
 'hasOwnProperty','isArray','isInteger','getItem','setItem','removeItem',
 'stringify','writeText','focus','blur','scrollIntoView','closest','matches',
 'insertAdjacentHTML','createTextNode','cloneNode','replaceChild','getBoundingClientRect',
}

def scan(path, block_index):
    s = open(path, encoding='utf-8').read()
    blocks = re.findall(r'<script>(.*?)</script>', s, re.S)
    # Every top-level <script> in a page shares one global scope, so a helper
    # declared in the app block is visible to the mock block at call time.
    js = "\n".join(blocks) if block_index is None else blocks[block_index]
    declared  = set(re.findall(r'function\s+([A-Za-z_$][\w$]*)\s*\(', js))
    declared |= set(re.findall(r'(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=', js))
    declared |= set(re.findall(r'([A-Za-z_$][\w$]*)\s*:\s*function', js))
    # function parameters, so a callback passed in by name is not flagged
    for params in re.findall(r'function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)', js):
        for tok in params.split(','):
            tok = tok.strip()
            if re.fullmatch(r'[A-Za-z_$][\w$]*', tok or ''):
                declared.add(tok)
    called = set(re.findall(r'(?<![\w.$"\'])([a-z][a-zA-Z0-9]*[A-Z][A-Za-z0-9_$]*)\s*\(', js))
    return sorted(c for c in called if c not in declared and c not in BUILTINS)

bad = 0
for path, idx, label in [("public/index.html", 0, "index"),
                         ("public/demo.html", None, "demo (both blocks)")]:
    m = scan(path, idx)
    print(f"{label:10s} undeclared calls: {m or 'none'}")
    if m: bad = 1

# ---------------------------------------------------------------------------
# Second guard: implicit globals.
#
# `gActSel` and `gActLists` were assigned but never declared. In sloppy mode an
# assignment silently creates a global, so the code parses and even half works
# -- but READING one before the first assignment throws a ReferenceError. That
# killed applyGradingLayout on its first call, so the Grading tab rendered and
# loaded nothing, with no error visible on the page.
#
# Anything assigned with a bare `name = ...` that is never declared anywhere is
# reported here.
def _regex_here(out):
    """True if a `/` at this point opens a regex literal rather than divides."""
    for ch in reversed(''.join(out[-40:])):
        if ch in ' \t\n\r': continue
        return ch in '(,=:[!&|?{};+-*%~^<>'
    return True

def strip_js(src):
    """Blank out comments and string/template literals.

    Regexes cannot do this: an apostrophe in a comment ("// the subgrade's own
    rows") opens a fake string that swallows everything up to the next quote.
    The first version of this guard lost 75% of the file that way and reported
    every real declaration as missing. A character scanner is the only honest
    way to know whether a quote is code or prose.
    """
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        nxt = src[i+1] if i + 1 < n else ''
        if c == '/' and nxt == '/':
            while i < n and src[i] != '\n': i += 1
        elif c == '/' and nxt == '*':
            i += 2
            while i < n and not (src[i] == '*' and i+1 < n and src[i+1] == '/'): i += 1
            i += 2
        elif c == '/' and _regex_here(out):
            # A regex literal, not division. `/[?&]demo=1(&|$)/` otherwise looks
            # like an assignment to an undeclared `demo`. Told apart by the last
            # significant character: after a value, `/` divides; after an
            # operator, bracket or start of statement, it opens a regex.
            i += 1
            while i < n:
                if src[i] == '\\': i += 2; continue
                if src[i] == '[':
                    while i < n and src[i] != ']':
                        i += 2 if src[i] == '\\' else 1
                if src[i] == '/': i += 1; break
                if src[i] == '\n': break
                i += 1
            out.append('""')
        elif c in '"\'`':
            q = c; i += 1
            while i < n:
                if src[i] == '\\': i += 2; continue
                if src[i] == q: i += 1; break
                i += 1
            out.append('""')
        else:
            out.append(c); i += 1
    return ''.join(out)

def implicit_globals(path, block_index=None):
    s = open(path, encoding='utf-8').read()
    blocks = re.findall(r'<script>(.*?)</script>', s, re.S)
    js = "\n".join(blocks) if block_index is None else blocks[block_index]
    js = strip_js(js)

    # A var statement can declare several names -- `var oLoading = false,
    # oError = "";` -- so take every identifier in the statement, not just the
    # first. Missing this reported six perfectly ordinary variables.
    declared = set()
    for stmt in re.findall(r'(?:var|let|const)\s+([^;\n]*)', js):
        depth = 0; buf = ''
        for ch in stmt:
            if ch in '([{': depth += 1
            elif ch in ')]}': depth -= 1
            if depth == 0 and ch == ',': 
                buf = ''
                continue
            buf += ch
            m = re.match(r'\s*([A-Za-z_$][\w$]*)\s*(?:=|$)', buf)
            if m: declared.add(m.group(1))
        for m in re.finditer(r'(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?==|,|$)', stmt):
            declared.add(m.group(1))
    declared |= set(re.findall(r'function\s+([A-Za-z_$][\w$]*)', js))
    for params in re.findall(r'function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)', js):
        for tok in params.split(','):
            tok = tok.strip()
            if re.fullmatch(r'[A-Za-z_$][\w$]*', tok or ''):
                declared.add(tok)
    # catch(e), for(x in y)
    declared |= set(re.findall(r'catch\s*\(\s*([A-Za-z_$][\w$]*)', js))
    declared |= set(re.findall(r'for\s*\(\s*([A-Za-z_$][\w$]*)\s+in\s', js))

    assigned = set()
    for m in re.finditer(r'(?<![\w.$])([A-Za-z_$][\w$]*)\s*=(?![=>])', js):
        name = m.group(1)
        before = js[max(0, m.start()-12):m.start()]
        if re.search(r'(?:var|let|const)\s+$|[,{(]\s*$', before):
            continue
        assigned.add(name)
    return sorted(a for a in assigned if a not in declared and a not in BUILTINS)

bad2 = 0
for path, idx, label in [("public/index.html", 0, "index"),
                         ("public/demo.html", None, "demo (both blocks)")]:
    m = implicit_globals(path, idx)
    print(f"{label:10s} implicit globals: {m or 'none'}")
    if m: bad2 = 1
sys.exit(bad or bad2)
