# SOTA Research Initiative — Methodology

Canonical copy of the research methodology for the feedBack state-of-the-art tool review, first
published as [feedBack#13](https://github.com/get-flashbacks/feedBack/issues/13), with the companion
prioritization and impact analysis in [feedBack#14](https://github.com/get-flashbacks/feedBack/issues/14).

**Why this file exists.** The core research issue ([feedBack#4](https://github.com/get-flashbacks/feedBack/issues/4))
and each canonical plugin-repo research issue cite `docs/sota-research-plan.md` as "the research
plan" — but that path did not exist in this repository, so every one of those links was dead. This
file is that document, and it is the copy to correct going forward: edit this file, not the issue
body. (An issue body cannot be amended by a pull request, so a correction landed here still needs a
maintainer to sync the `#13` body by hand.)

Every deviation from the `#13` body is listed in [Corrections applied](#corrections-applied), with a
rationale for each.

## Research areas and where they are tracked

| # | Research area | Canonical tracking issue | In this repo |
|---|---|---|---|
| 1 | Pitch extraction — `librosa.pyin` → CREPE | [feedBack-plugin-lyrics-karaoke#2](https://github.com/get-flashbacks/feedBack-plugin-lyrics-karaoke/issues/2) | [`lib/vocal_pitch.py`](../lib/vocal_pitch.py) (client) |
| 2 | Stem separation — demucs v3 → v4, GP8 parsing | [feedBack#4](https://github.com/get-flashbacks/feedBack/issues/4) | `feedBack-demucs-server` (external service); [`lib/gp2rs_gpx.py`](../lib/gp2rs_gpx.py) |
| 3 | Lyrics alignment — WhisperX → Faster-Whisper | [feedBack-plugin-lyrics-sync#2](https://github.com/get-flashbacks/feedBack-plugin-lyrics-sync/issues/2) | [`lib/lyrics_transcribe.py`](../lib/lyrics_transcribe.py) |
| 4 | Chord detection — design decision | *(no canonical issue — see correction 10)* | — |
| 5 | Adaptive difficulty — EMA → Kalman / IRT | [feedBack-plugin-difficulty-ladder#31](https://github.com/get-flashbacks/feedBack-plugin-difficulty-ladder/issues/31) | — |

Stray copies of areas 1, 3, 4 and 5 were also filed in this repository (#5, #6, #7, #8). They were
administratively closed; the plugin-repo issues above are the canonical ones.

### Scope notes — where these tools actually live

The `#13` body is written as though every candidate tool were a dependency of this repository. It
is not, and Phase 2 instructions that assume otherwise are not executable here:

- **Stem separation is not a core dependency.** The assembly pipeline (`lib/sloppak_convert.py`)
  has been removed; separation is delegated to the separate `feedBack-demucs-server` service over
  `DEMUCS_SERVER_URL`. A demucs v3-vs-v4 comparison is a `feedBack-demucs-server` exercise.
- **GP8 already parses.** GP6/7/8 containers are read by [`lib/gp2rs_gpx.py`](../lib/gp2rs_gpx.py)
  (`pyguitarpro>=0.10.1` covers GP3–GP5), with tests in `tests/test_gp2rs_gpx.py`. Area 2's GP8 half
  is a documentation and regression check, not a benchmark.
- **Pitch already runs CREPE server-side.** [`lib/vocal_pitch.py`](../lib/vocal_pitch.py) exposes
  only a remote path, against a `/pitch` endpoint that runs CREPE. pYIN is the *local plugin
  fallback*, not the system's primary engine — so area 1's question is really "does the plugin's
  local path still need to exist, and can it match the server cheaply enough to be worth keeping?"
- **Transcription is a service call too.** `lib/lyrics_transcribe.py` runs WhisperX either in-process
  or on the demucs server, which changes where latency work for area 3 has to happen.

---

## Phase 1: Literature review (2–4 hours per research area)

**Objective:** Understand the landscape of competing tools, academic context, and community feedback.

**Deliverables:**
- [ ] Identify 3–5 peer-reviewed papers or authoritative resources on the topic
- [ ] List GitHub repositories for each alternative tool
- [ ] Note any published benchmarks or comparison studies
- [ ] Collect community feedback (GitHub issues, discussions, Reddit, academic forums)

**Output format:**

```markdown
## Literature Review

### Papers
- [Paper Title](url) — [Key finding: X]
- [Paper Title](url) — [Key finding: Y]

### GitHub Repositories
- [Tool A](url) — [Status: active/archived], [Last update: date]
- [Tool B](url) — [Status: active/archived], [Last update: date]

### Benchmarks & Comparisons
- [Benchmark Name](url) — [Results summary]

### Community Feedback
- [Issue/Discussion](url) — [Key insight]
```

**Note on metric comparability.** Published papers rarely report the metrics defined in Phase 3
under the same names, and some that look like matches are not. Compare definitions before quoting
numbers — e.g. Kroon (2022), *Comparing Conventional Pitch Detection Algorithms with a Neural
Network Approach* ([arXiv:2206.14357](https://arxiv.org/abs/2206.14357)), compares pYIN / YAAPT /
CREPE via a figure of merit split into gross-pitch, fine-pitch, voiced-to-voiced and
unvoiced-to-voiced error rates. Gross pitch error is **not** the same quantity as the octave-error
rate below, so its CREPE-vs-pYIN numbers cannot be dropped into the Success Criteria table as-is.

---

## Phase 2: Proof-of-concept setup (4–8 hours)

**Objective:** Get the alternative tool(s) running on test data to assess feasibility.

**Deliverables:**
- [ ] Install/configure each alternative alongside the current tool
- [ ] Prepare 3–5 test cases (sample audio, charts, or data)
- [ ] Run both implementations on the same test data
- [ ] Document setup steps and any blockers encountered
- [ ] Collect basic qualitative observations (speed, ease of use, quality)

**Output format:**

```python
# Example: Pitch extraction PoC
import librosa
import torchcrepe

audio, sr = librosa.load('test_vocal.wav')

# Current approach (pYIN)
f0_pyin, voiced_pyin, voicing_prob_pyin = librosa.pyin(
    audio, fmin=80, fmax=400, sr=sr
)

# Alternative (CREPE)
f0_crepe = torchcrepe.predict(
    audio, sr, viterbi=True, return_confidence=False
)

# Compare outputs — see octave_error_rate() in Phase 3.
# Frame grids must be resampled to a common hop before comparing.
print(f"pYIN octave errors: {octave_error_rate(f0_pyin, f0_pyin_ref)}")
print(f"CREPE octave errors: {octave_error_rate(f0_crepe, f0_pyin_ref)}")
```

**Qualitative notes:**
- Latency observations (inference time per sample)
- Memory usage / resource requirements
- Ease of integration into existing pipeline
- Any unexpected behavior or edge cases

---

## Phase 3: Benchmark and evaluation (8–16 hours)

**Objective:** Quantitatively measure performance differences on a realistic dataset.

**Deliverables:**
- [ ] Select or create a benchmark dataset (see dataset guidance below)
- [ ] Define 2–3 primary evaluation metrics and success criteria
- [ ] Run both implementations on the full dataset
- [ ] Collect raw measurements (latency, accuracy, resource usage)
- [ ] Generate comparison visualizations (plots, tables, traces)
- [ ] Manual inspection / listening test (where applicable)

### Benchmark datasets (by research area)

| Research Area | Benchmark | Size | URL | Notes |
|---|---|---|---|---|
| **Pitch extraction** | MIR-1K | 1000 clips | http://www.music.cs.cmu.edu/mirdata/ | Chinese a cappella singing, note-level F0 labels |
| **Pitch extraction** | VoxCeleb | 2000+ speakers | https://www.robots.ox.ac.uk/~vgg/data/voxceleb/ | Diverse **speech**, not singing — useful for robustness, not for vocal-pitch accuracy |
| **Stem separation** | MUSDB18 | 150 songs | https://sigsep.github.io/musdb/ | Standard benchmark, 4 stems |
| **Chord detection** | Isophonics | 200+ songs | http://isophonics.cs.upf.edu/ | Annotated chord boundaries + symbols |
| **Lyrics alignment** | *No public set fits* | — | — | See note below |

**Lyrics alignment has no drop-in public dataset.** The `#13` body specified Common Voice and noted
a "singing subset available". Common Voice is Mozilla's **read-speech** corpus — sentences recorded
by speakers reading a script aloud — and it contains no singing subset. Word error rate measured on
read speech does not predict singing transcription quality, so a Common Voice number cannot answer
the question area 3 asks. This phase needs a purpose-built annotated set (10–30 vocal stems with
hand-corrected transcripts and syllable timings) and is **blocked** until someone produces one.

### Metrics by research area

**Pitch extraction:**

```python
import numpy as np


def octave_error_rate(predicted, ground_truth, threshold_cents=50):
    """% of frames with an octave (±1200 cent) error.

    Errors are kept *signed* so both octave directions are detectable. An
    absolute-error implementation cannot detect the downward octave at all:
    with `errors >= 0`, the `|errors + 1200| < threshold` branch is never
    true, which understates the rate by up to 2x on octave-flipped material.
    """
    errors = np.asarray(predicted, dtype=float) - np.asarray(ground_truth, dtype=float)
    finite = np.isfinite(errors)
    if not finite.any():
        return float('nan')
    octave_errors = (np.abs(errors - 1200) < threshold_cents) | \
                    (np.abs(errors + 1200) < threshold_cents)
    return np.mean(octave_errors[finite]) * 100


def voicing_accuracy(predicted_voiced, ground_truth_voiced):
    """% frames where voicing detection agrees"""
    p = np.asarray(predicted_voiced, dtype=bool)
    g = np.asarray(ground_truth_voiced, dtype=bool)
    return np.mean(p == g) * 100


def raw_pitch_accuracy(predicted, predicted_voiced, ground_truth, ground_truth_voiced,
                       threshold_cents=50):
    """% of mutually voiced frames within threshold_cents of ground truth.

    Unvoiced frames are excluded from *both* sides of the ratio. Leaving
    them in the denominator while their predicted F0 is NaN quietly
    penalizes whichever engine marks more frames unvoiced, and comparing
    two engines on this metric without a mask measures voicing policy as
    much as pitch accuracy.
    """
    p = np.asarray(predicted, dtype=float)
    g = np.asarray(ground_truth, dtype=float)
    both_voiced = np.asarray(predicted_voiced, dtype=bool) & np.asarray(ground_truth_voiced, dtype=bool)
    if not both_voiced.any():
        return float('nan')
    errors = np.abs(p[both_voiced] - g[both_voiced])
    return np.mean(errors < threshold_cents) * 100
```

**Stem separation:**

```python
def signal_distortion_ratio(reference, predicted):
    """Higher is better (0-inf, typical range 5-15 dB)"""
    s_target = np.inner(predicted, reference) / np.inner(reference, reference) * reference
    e_noise = predicted - s_target
    return 10 * np.log10(np.sum(s_target**2) / (np.sum(e_noise**2) + 1e-8))


# Run on MUSDB18 subset:
for track in musdb.Dataset(split='test'):
    estimates = separate(track.audio)  # Both v3 and v4
    for source in ['vocals', 'drums', 'bass', 'other']:
        sdr_v3 = signal_distortion_ratio(track.sources[source], estimates_v3[source])
        sdr_v4 = signal_distortion_ratio(track.sources[source], estimates_v4[source])
        print(f"{track.name} {source}: v3={sdr_v3:.2f} dB, v4={sdr_v4:.2f} dB")
```

Report the per-source mean **and** the per-source spread. A mean SDR gain driven by one source is a
different finding from a uniform gain, and a single aggregate number hides the difference.

**Chord detection:**

```python
import re

_ROOT = re.compile(r'^([A-G])([#b]{0,2})')
_QUALITY_ALIASES = {
    '': 'maj', 'maj': 'maj', 'M': 'maj',
    'min': 'min', 'm': 'min',
    'maj7': '7', 'M7': '7', '7': '7', 'Δ7': '7',
    'min7': 'm7', 'm7': 'm7',
    'dim': 'dim', 'aug': 'aug', 'sus4': 'sus4', 'sus2': 'sus2',
    '9': '9', 'maj9': '9', '11': '11', '13': '13',
}


def normalize_chord(symbol):
    """Reduce a chord label to a comparable (root, quality, bass) tuple.

    Raw string equality is not a metric: `C`, `Cmaj`, `CM` and `CMaj7` /
    `Cmaj7` are one chord to a listener and four different strings, so
    unnormalized comparison measures labelling style rather than accuracy.
    Both sides of every comparison must be normalized.
    """
    if symbol is None:
        return None
    m = _ROOT.match(str(symbol).strip())
    if not m:
        return ('?', str(symbol).strip().lower())
    root = m.group(1) + m.group(2).replace('#', '♯').replace('b', '♭')
    rest = str(symbol).strip()[m.end():]
    bass = None
    if '/' in rest:
        rest, _, bass_part = rest.partition('/')
        bass = _ROOT.match(bass_part).group(1) if _ROOT.match(bass_part) else bass_part
    quality = _QUALITY_ALIASES.get(rest, rest or 'maj')
    return (root, quality, bass)


def chord_accuracy(predicted_chords, ground_truth_chords, frame_rate=10):
    """% of frames whose normalized chord matches ground truth.

    Both label streams must be resampled to the same frame grid first;
    `zip` silently truncates to the shorter of the two otherwise.
    """
    pred = [normalize_chord(c) for c in predicted_chords]
    gt = [normalize_chord(c) for c in ground_truth_chords]
    if len(pred) != len(gt):
        raise ValueError(f"label streams must be frame-aligned: {len(pred)} vs {len(gt)}")
    if not gt:
        return float('nan')
    return sum(1 for p, g in zip(pred, gt) if p == g) / len(gt) * 100


def boundary_accuracy(predicted_boundaries, ground_truth_boundaries, tolerance_sec=0.5):
    """% of ground-truth boundaries matched by some prediction within tolerance_sec.

    Matches are counted from the ground-truth side. Counting predictions
    and dividing by the ground-truth count — as the `#13` version did —
    can exceed 100% whenever predictions are denser, which makes the
    number uninterpretable as a percentage.
    """
    if not ground_truth_boundaries:
        return float('nan')
    predicted_boundaries = np.asarray(predicted_boundaries, dtype=float)
    matched = sum(
        1 for gt_t in ground_truth_boundaries
        if np.any(np.abs(predicted_boundaries - float(gt_t)) < tolerance_sec)
    )
    return matched / len(ground_truth_boundaries) * 100
```

`boundary_accuracy` defaults to `tolerance_sec=0.5` here to match the Isophonics-style reporting
that chord-detection literature uses; the Success Criteria table below states the tolerance it
actually gates on, so the two cannot drift apart silently.

**Lyrics alignment (Whisper variants):**

```python
def word_error_rate(predicted_transcript, ground_truth_transcript):
    """Lower is better (0-100+). Levenshtein distance over words / reference length.

    Requires a real edit distance. `difflib.SequenceMatcher(None, a, b).ratio()`
    — the version in the `#13` body — is a similarity ratio, not WER: it is
    not edit-distance based, it ignores the reference-length denominator
    (so a shorter correct prediction is not rewarded), and it substitutes
    order-preserving blocks for substitutions. It cannot be compared with a
    published WER figure.
    """
    import jiwer
    return jiwer.wer(ground_truth_transcript, predicted_transcript) * 100


def alignment_accuracy(predicted_times, ground_truth_times, tolerance_ms=50):
    """% of syllables with timing within tolerance_ms"""
    if len(predicted_times) != len(ground_truth_times):
        raise ValueError(f"token streams must be aligned: {len(predicted_times)} vs {len(ground_truth_times)}")
    if not ground_truth_times:
        return float('nan')
    matches = sum(1 for pt, gt in zip(predicted_times, ground_truth_times)
                  if abs((pt - gt) * 1000) < tolerance_ms)
    return matches / len(ground_truth_times) * 100
```

Report WER and alignment accuracy as a pair. A swap that lowers WER while degrading timing — by
dropping the forced-alignment stage — is the exact regression the decision rule below exists to
catch, and neither number catches it alone.

**Adaptive difficulty (Kalman vs. EMA):**

```python
def engagement_retention(player_sessions_algorithm_a, player_sessions_algorithm_b):
    """% of players who complete N songs.

    Directional guardrail only — see the note in the Success Criteria table.
    """
    def rate(sessions):
        if not sessions:
            return float('nan')
        return sum(1 for s in sessions if s.completed_songs >= 3) / len(sessions)

    complete_a = sum(1 for s in player_sessions_algorithm_a if s.completed_songs >= 3)
    complete_b = sum(1 for s in player_sessions_algorithm_b if s.completed_songs >= 3)
    rate_a, rate_b = rate(player_sessions_algorithm_a), rate(player_sessions_algorithm_b)
    # The `#13` version divided by complete_a, which raises ZeroDivisionError
    # on a zero-completion arm instead of reporting the result.
    return {
        'algorithm_a': rate_a,
        'algorithm_b': rate_b,
        'improvement': (rate_b - rate_a) / rate_a * 100 if rate_a else float('nan'),
    }


def difficulty_stability(mastery_adjustments_per_song):
    """Lower variance = more stable algorithm"""
    return np.std(mastery_adjustments_per_song)
```

### Output format (CSV for comparison)

```
Song,Tool,Metric,Value,Latency_ms,CPU%
test_vocal_1.wav,pYIN,octave_error_rate,2.1,120,15
test_vocal_1.wav,CREPE,octave_error_rate,1.3,450,45
test_vocal_2.wav,pYIN,octave_error_rate,5.4,120,15
test_vocal_2.wav,CREPE,octave_error_rate,0.9,450,45
```

**Visualizations:**
- [ ] Line plot: metric vs. test case
- [ ] Box plot: distribution comparison (mean, median, quartiles)
- [ ] Scatter: accuracy vs. latency trade-off
- [ ] Waterfall chart: relative improvement (%) across test set

Record hardware (CPU model, GPU, core count) and library versions alongside every latency number.
Latency figures are meaningless — and actively misleading in review — without them.

---

## Phase 4: Decision and report (2–4 hours)

**Objective:** Synthesize findings and make adoption recommendation.

**Deliverables:**
- [ ] Summary of Phase 1–3 findings
- [ ] Clear **adoption decision** with reasoning
- [ ] Implementation plan (if adopting alternative)
- [ ] Risk assessment and migration cost estimate
- [ ] Next steps and owner assignment

**Decision framework:**

```
IF (primary_metric_improvement > threshold) AND (latency_acceptable) AND (integration_effort_low):
    RECOMMENDATION = "ADOPT"
ELIF (primary_metric_improvement > threshold) BUT (latency_regression > 20%):
    RECOMMENDATION = "ADOPT with optimization track" OR "DEFER to optimization phase"
ELIF (primary_metric_improvement < threshold) OR (integration_effort_high):
    RECOMMENDATION = "MONITOR" OR "REJECT"
ELSE:
    RECOMMENDATION = "REQUEST STAKEHOLDER INPUT"
```

`DEFER` and `REQUEST STAKEHOLDER INPUT` are real outcomes of the framework above, so the closing
vocabulary admits them too. Resolving one to the narrowest of {ADOPT, ADOPT with optimization
track, DEFER, MONITOR, REJECT, REQUEST STAKEHOLDER INPUT} is what "complete" means for Phase 4.

A Phase 4 that does not name a decision is not Phase 4. An issue closed without a written rationale
does not count, regardless of how correct the underlying judgement was — the reasoning is the
deliverable, and it is what the next researcher needs in order not to redo the work.

**Report template:**

```markdown
## Research Report: [Tool Name] vs. Current [X]

### Executive Summary
- **Recommendation:** ADOPT / REJECT / MONITOR / DEFER
- **Primary Metric:** [Current] vs. [Alternative] = [Δ%] improvement
- **Secondary Metrics:** [List trade-offs]
- **Implementation effort:** [hours/days]
- **Risk:** [low/medium/high]

### Findings

#### Accuracy
- [Current tool]: [metric value]
- [Alternative tool]: [metric value]
- **Winner:** [Tool] (+X% improvement)

#### Performance (Latency)
- [Current tool]: [msec/sec audio]
- [Alternative tool]: [msec/sec audio]
- **Trade-off:** [Assessment]

#### Integration Difficulty
- **Setup:** [hours]
- **API changes:** [yes/no, describe]
- **Deployment:** [local/remote/hybrid]

### Recommendation
[Full reasoning]

### Next Steps
- [ ] Assign owner for implementation
- [ ] Open tracking issue for adoption
- [ ] Schedule integration review
```

---

## Success criteria template (per research area)

| Research Area | Benchmark | Primary Metric | Success Threshold | Secondary Metrics |
|---|---|---|---|---|
| **Pitch** | MIR-1K | Octave error rate | < 5% | Latency ≤ 500ms/5s audio (CPU) |
| **Stems** | MUSDB18 | SDR improvement | > 1 dB | Latency increase < 20% |
| **Chords** | Isophonics | Chord accuracy (normalized labels) | ≥ 70% | Boundary accuracy, tolerance **±500 ms** |
| **Lyrics** | Hand-transcribed singing set | WER parity | ≤ 1% increase | Latency < 0.5× WhisperX |
| **Difficulty** | Simulated players + player sessions | Estimator tracking error | ≥ 30% reduction vs. EMA | Retention, directional guardrail only |

Two notes on this table:

- **Chords.** The tolerance was previously `±50ms` here while the reference implementation in the
  same document defaulted to `0.5s`. 50 ms is far tighter than boundary annotation noise supports,
  so it would have failed every candidate for a reason unrelated to its quality. State the tolerance
  once, and use it in both places.
- **Difficulty.** `engagement retention ≥ 10% improvement` is not executable at the documented data
  scale. Detecting a 50% → 55% change at α = 0.05 and 80% power needs on the order of 1,600 players
  per arm; even a generous 50% → 60% needs hundreds. At 5–20 sessions, any observed "≥10%" swing is
  indistinguishable from sampling noise. Use estimator-level metrics — tracking error against
  known ground truth, difficulty-oscillation variance, time to convergence, calibration of predicted
  vs. actual hit rate — as the primary metric, and report retention directionally as a guardrail.
  See [feedBack-plugin-difficulty-ladder#31](https://github.com/get-flashbacks/feedBack-plugin-difficulty-ladder/issues/31)
  for the worked version of this rule.

---

## What is blocked without datasets or compute

Being explicit about this is part of the deliverable. None of the following can be produced from a
laptop in an ephemeral CI environment; each needs a dataset download, a GPU box, or human subjects:

| Phase | Area | Blocker |
|---|---|---|
| Phase 3 | Pitch | MIR-1K download (~1 GB) plus model inference; GPU strongly preferred for CREPE |
| Phase 3 | Stems | MUSDB18 download plus multi-hour separation runs; scoring belongs in `feedBack-demucs-server` |
| Phase 3 | Chords | Isophonics download (registration required) plus per-track inference |
| Phase 3 | Lyrics | **No suitable dataset exists** — see the dataset note above; a purpose-built annotated set must be created first |
| Phase 3 | Difficulty | Real player sessions, or a simulator; the simulation-first design is the only version feasible without human subjects |

Phase 1 (literature review) and Phase 2 (PoC setup) are the phases that can be completed from
repositories and public sources alone. Where Phases 1–3 cannot be run, record that as **BLOCKED**
with the specific missing input — not as a partial number.

---

## How to use this guide

1. **Pick a research area** from the table above.
2. **Follow Phase 1–4 in order** (don't skip; each builds on the last).
3. **Document findings** using the templates above.
4. **Comment on the issue** with Phase completion status and key findings as you go.
5. **Final report:** post a comprehensive summary in the Phase 4 section.
6. **Close with decision:** researcher and maintainer agree on one of ADOPT / ADOPT with optimization
   track / DEFER / MONITOR / REJECT / REQUEST STAKEHOLDER INPUT.

## Corrections applied

Every difference from the `#13` issue body, and why:

1. **Octave-error metric could only detect one direction.** The body took an absolute error and then
   tested `|errors + 1200| < threshold`, which is never true for non-negative `errors`. Now uses
   signed errors. *Materially understates octave error on octave-flipped material.*
2. **Raw pitch accuracy had no voicing mask.** Unvoiced frames sat in the denominator while their F0
   was `NaN`, and `NaN < threshold` is `False` — so the metric silently penalized whichever engine
   marked more frames unvoiced. `raw_pitch_accuracy` now takes both voicing streams and restricts
   the ratio to mutually voiced frames.
3. **`word_error_rate` was not WER.** `difflib.SequenceMatcher(...).ratio()` is a similarity ratio,
   not an edit-distance word error rate, and cannot be compared against published WER figures.
   Replaced with `jiwer.wer`.
4. **Boundary accuracy counted the wrong side and could exceed 100%.** It matched predicted
   boundaries and divided by the ground-truth count. Now counts matches from the ground-truth side.
5. **Chord accuracy compared raw label strings**, so `C` vs `Cmaj` vs `CMaj7` scored as wrong
   answers. Both sides are now normalized to `(root, quality, bass)` before comparison.
6. **`engagement_retention` divided by `complete_a`**, raising `ZeroDivisionError` on a zero-completion
   arm instead of returning a result.
7. **Common Voice has no singing subset.** It is a read-speech corpus. The benchmark row now records
   that the lyrics-alignment area has no usable public dataset, and Phase 3 for that area is marked
   blocked on building one.
8. **The difficulty retention criterion was not statistically executable** at the documented sample
   size. Replaced with estimator-level primary metrics; retention is now a directional guardrail,
   cross-referenced to the worked critique in `feedBack-plugin-difficulty-ladder#31`.
9. **Boundary tolerance contradicted itself** — `±50ms` in the criteria table, `0.5s` in the code.
   Unified on `±500ms` and noted where it is gated.
10. **The chord-detection tracking link is dead.** `feedback-plugin-chord-detector` no longer exists;
    the URL now resolves through a rename chain to `feedBack-plugin-chordr#3`, an unrelated feature
    issue. The canonical research issue for that area needs to be recreated — the nearest surviving
    trace is [feedBack-plugin-chordr#5](https://github.com/get-flashbacks/feedBack-plugin-chordr/issues/5)
    (*[Backlog] Audio-based chord detection as a fallback source*), which records that the original
    question is still open and names a concrete chroma-based candidate.
11. **`docs/sota-research-plan.md` did not exist**, although feedBack#4 and the canonical
    plugin-repo research issues link to it as the research plan. This file is that document.
12. **Phase 2's example called an undefined helper.** The snippet invoked `count_octave_errors()`,
    which the document never defined; it now calls the `octave_error_rate()` defined in Phase 3.
13. **The closing vocabulary was narrower than the decision framework**, which can emit `DEFER` and
    `REQUEST STAKEHOLDER INPUT`. Aligned.
14. **A "Scope notes" section was added**, because the body's benchmark and PoC instructions assume
    every candidate tool is a dependency of this repository, and several no longer are.