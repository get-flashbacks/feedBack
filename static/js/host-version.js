// Host-version comparison for the plugin `minHost` floor (feedBack#133).
//
// Mirrors lib/host_versions.py: prerelease-aware semver ordering plus the
// unset / placeholder / real / invalid classification. The server already
// evaluates every plugin at load time and serves `min_host_status` on each
// /api/plugins row — this module exists so the loader can ALSO evaluate
// locally (older hosts serve rows without the field) and so the rule has
// one definition both sides can test against.
//
// `minHost` is diagnostic-only: nothing here blocks, skips, or degrades a
// plugin. The loader warns once per unmet plugin (naming the plugin, the
// floor, and the running host); the warning lands in the console ring
// buffer, which is exactly what the diagnostics bundle exports.

// The placeholder existing manifests carry — predates any real dependency,
// so it is labelled but never acted on.
export const MIN_HOST_PLACEHOLDERS = ['1.0.0'];

const VERSION_RE = /^[vV=]?\s*(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\s*$/;

function _parse(version) {
    if (typeof version !== 'string') return null;
    const m = VERSION_RE.exec(version.trim());
    if (!m) return null;
    const core = m[1].split('.').map(Number);
    if (core.some((n) => !Number.isFinite(n))) return null;
    const pre = m[2] === undefined ? [] : m[2].split('.').map((id) => (/^\d+$/.test(id) ? parseInt(id, 10) : id));
    return { core, pre };
}

// Numeric left-to-right core ordering (missing parts are zero).
// Returns -1/0/1, or null when the cores tie and the prerelease decides.
function _compareCores(coreA, coreB) {
    const width = Math.max(coreA.length, coreB.length);
    for (let i = 0; i < width; i++) {
        const na = coreA[i] || 0;
        const nb = coreB[i] || 0;
        if (na !== nb) return na < nb ? -1 : 1;
    }
    return null;
}

// One prerelease-identifier step: numeric identifiers compare numerically
// and sort below alphanumerics; alphanumerics compare lexically. Null
// means this pair ties — keep walking.
function _compareIdentifier(ia, ib) {
    if (ia === ib) return null;
    const na = typeof ia === 'number';
    const nb = typeof ib === 'number';
    if (na && nb) return ia < ib ? -1 : 1;
    if (na) return -1;
    if (nb) return 1;
    return ia < ib ? -1 : 1;
}

// Prerelease ordering once the cores tie: a release sorts after any
// prerelease of the same core; identifier lists compare element-wise,
// then fall back to length.
function _comparePrereleases(preA, preB) {
    if (preA.length === 0 && preB.length === 0) return 0;
    if (preA.length === 0) return 1;
    if (preB.length === 0) return -1;
    const n = Math.min(preA.length, preB.length);
    for (let i = 0; i < n; i++) {
        const step = _compareIdentifier(preA[i], preB[i]);
        if (step !== null) return step;
    }
    if (preA.length === preB.length) return 0;
    return preA.length < preB.length ? -1 : 1;
}

// Order two bare versions: -1 if a < b, 0 if equal, 1 if a > b.
// Throws when either side is not a bare version — classify first.
export function compareHostVersions(a, b) {
    const pa = _parse(a);
    const pb = _parse(b);
    if (!pa) throw new Error(`not a bare version: ${JSON.stringify(a)}`);
    if (!pb) throw new Error(`not a bare version: ${JSON.stringify(b)}`);
    const coreResult = _compareCores(pa.core, pb.core);
    if (coreResult !== null) return coreResult;
    return _comparePrereleases(pa.pre, pb.pre);
}

// Bucket a raw manifest `minHost`: unset | placeholder | real | invalid.
// Only `real` values are ever compared against the host.
export function classifyMinHost(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return 'unset';
    const text = raw.trim();
    if (MIN_HOST_PLACEHOLDERS.indexOf(text) !== -1) return 'placeholder';
    return _parse(text) ? 'real' : 'invalid';
}

// Full per-plugin status: unset | placeholder | invalid | ok | unmet.
// An unparseable host fails open to `ok` — a diagnostic must never cry
// mismatch against a version it cannot read.
export function minHostStatus(minHost, hostVersion) {
    if (classifyMinHost(minHost) !== 'real') return classifyMinHost(minHost);
    try {
        return compareHostVersions(hostVersion, minHost) >= 0 ? 'ok' : 'unmet';
    } catch {
        return 'ok';
    }
}

export function describeMinHostGap(pluginId, minHost, hostVersion) {
    return `Plugin '${pluginId}' declares minHost '${minHost}' but the host`
        + ` is at '${hostVersion}' — loading anyway (minHost is diagnostic-only;`
        + ` prefer feature detection, see docs/plugin-host-compat.md).`;
}

// Evaluate a /api/plugins row list against a host version, returning one
// gap descriptor per unmet plugin. Prefers the server-computed
// `min_host_status` (evaluated at load time against the booted version)
// and falls back to a local evaluation for rows from older hosts.
export function minHostGaps(plugins, hostVersion) {
    const out = [];
    for (const p of plugins || []) {
        if (!p || !p.id) continue;
        const status = (typeof p.min_host_status === 'string' && p.min_host_status)
            ? p.min_host_status
            : minHostStatus(p.min_host, hostVersion);
        if (status === 'unmet') {
            out.push({ id: p.id, minHost: p.min_host, hostVersion, message: describeMinHostGap(p.id, p.min_host, hostVersion) });
        }
    }
    return out;
}
