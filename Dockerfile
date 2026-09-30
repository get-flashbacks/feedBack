# ── Stage 1b: Build native vgmstream-cli for target arch ─────────────────────
FROM python:3.12-slim AS vgmstream-builder
ARG VGMSTREAM_REF=r2083

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    pkg-config \
    yasm \
    libmpg123-dev \
    libvorbis-dev \
    libspeex-dev \
    libopus-dev \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${VGMSTREAM_REF}" https://github.com/vgmstream/vgmstream.git /tmp/vgmstream

RUN cmake -S /tmp/vgmstream -B /tmp/vgmstream/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_V123=OFF \
        -DBUILD_AUDACIOUS=OFF \
        -DBUILD_SHARED_LIBS=OFF \
        -DUSE_FFMPEG=OFF \
    && cmake --build /tmp/vgmstream/build --config Release --target vgmstream_cli -j"$(nproc)" \
    && mkdir -p /out \
    && cp /tmp/vgmstream/build/cli/vgmstream-cli /out/vgmstream-cli

# ── Stage 1c: Fetch static ffmpeg ─────────────────────────────────────────
# Throwaway stage — only the ffmpeg/ffprobe binaries cross into the final
# image via COPY. Doing the download here (rather than in stage 2) means
# the final image never has to install curl, which transitively pulls in
# libcurl4t64 → librtmp1 → libgnutls30t64 (and therefore gnutls28 with
# its unfixed HIGH CVEs). Alpine is used because it's tiny and the
# download tools don't need any of Debian's TLS baggage.
#
# Source: BtbN/FFmpeg-Builds (GPL static build, 7.1 series).
#
# Pinned, never floating. BtbN documents its release retention policy as
# "the last build of each month is kept for two years / the last 14 daily
# builds are kept / the special 'latest' build floats" (README, "Release
# Retention Policy"). So a month-end autobuild tag is a retained immutable
# source, while `latest` is a mutable ref whose assets are replaced in place
# — under `latest` two builds of the same commit can embed different
# binaries, and the release/asset names recorded in the image labels below
# cannot identify the bytes that actually shipped. HTTPS proves transport to
# GitHub, not artifact identity; the SHA-256 ARGs do that, and the image
# digest only identifies the already-built output.
#
# Retention window: this tag is a month-end build, so it is good for two
# years — until 2028-07-31, after which BtbN may delete it. The pre-flight
# check in build-proxmox-ct.sh (and the release still resolving during a
# Docker build) will fail loudly at that point rather than building an image
# whose ffmpeg is unfetchable.
#
# Why 7.1 specifically, and when to bump: 7.1 is a terminal (LTS) FFmpeg
# series — it receives no new upstream fixes by design, so it is the correct
# series to freeze a long-lived image on rather than a moving one. BtbN only
# publishes each series while it is current, so the month-end tag is the
# newest retained release that still carries 7.1 GPL linux assets; the
# `ffmpeg-n7.1-latest-*` names on newer tags 404. Revisit this when a
# maintained series is warranted (a security advisory, a feature the app
# actually uses) — not on a schedule, and not to chase a newer tag.
#
# To bump: pick a month-end tag from
#   https://github.com/BtbN/FFmpeg-Builds/releases
# that still publishes the target GPL linux builds, then take the two
# filenames and their hashes from that release's `checksums.sha256` asset
# and update the five FFMPEG_* ARGs here *and* in stage 2 (which repeats
# them for the labels) *and* the FFMPEG_* constants in
# build-proxmox-ct.sh — it ships the same binary to the Proxmox CT.
# tools/check_docker_pins.py (CI) enforces that those three places agree, and
# that the verification below is real code the shell executes — it rejects a
# name that drifted back to a floating `-latest-`, a check that is commented
# out or has its result discarded (`|| true`, `|| exit 0`, `set +e`), a check
# aimed at some other file, and a provenance label that no longer interpolates
# the pin it claims to record.
FROM alpine:3.20 AS ffmpeg-fetcher
ARG TARGETARCH
ARG FFMPEG_RELEASE=autobuild-2026-07-31-14-10
ARG FFMPEG_BUILD_AMD64=ffmpeg-n7.1.5-12-g1fdbca85aa-linux64-gpl-7.1.tar.xz
ARG FFMPEG_BUILD_ARM64=ffmpeg-n7.1.5-12-g1fdbca85aa-linuxarm64-gpl-7.1.tar.xz
ARG FFMPEG_SHA256_AMD64=c1e6caf48923dd8e6bc5e54d51ba70c321175b8162ae9c414c392990e72f0e79
ARG FFMPEG_SHA256_ARM64=a9a50c5782ef5e45306d58d1a9a819015b472d8da30ab6a77f15f571c861a71b
RUN apk add --no-cache curl xz \
    && arch="${TARGETARCH:-$(apk --print-arch)}" \
    && case "$arch" in \
         arm64|aarch64) FFMPEG_TARBALL="${FFMPEG_BUILD_ARM64}"; FFMPEG_SHA256="${FFMPEG_SHA256_ARM64}" ;; \
         amd64|x86_64)  FFMPEG_TARBALL="${FFMPEG_BUILD_AMD64}"; FFMPEG_SHA256="${FFMPEG_SHA256_AMD64}" ;; \
         *) echo "Unsupported arch: $arch" >&2; exit 1 ;; \
       esac \
    && if [ -z "$FFMPEG_SHA256" ]; then \
         echo "No FFMPEG_SHA256 pinned for ${arch} (${FFMPEG_TARBALL}) — refusing to build." >&2; \
         echo "Pin the SHA-256 from ${FFMPEG_RELEASE}'s checksums.sha256. There is deliberately no bypass flag: an unverified ffmpeg binary is not worth the build." >&2; \
         exit 1; \
       fi \
    && curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE}/${FFMPEG_TARBALL}" -o /tmp/ffmpeg.tar.xz \
    && echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
    && mkdir -p /tmp/ffmpeg-extract /out \
    && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg-extract --strip-components=1 \
    && cp /tmp/ffmpeg-extract/bin/ffmpeg /tmp/ffmpeg-extract/bin/ffprobe /out/ \
    && cp /tmp/ffmpeg-extract/LICENSE.txt /out/LICENSE.txt \
    && printf '%s\n' \
         "ffmpeg/ffprobe in this image are static GPL builds from BtbN/FFmpeg-Builds." \
         "" \
         "  Release: ${FFMPEG_RELEASE}" \
         "  Tarball: ${FFMPEG_TARBALL}" \
         "  SHA-256: ${FFMPEG_SHA256}" \
         "" \
         "Verified against the pinned hash at build time; see the" \
         "org.feedBack.ffmpeg.* image labels for the same values." \
         "" \
         "Corresponding source (GPL):" \
         "  - Build recipe + scripts: https://github.com/BtbN/FFmpeg-Builds/tree/${FFMPEG_RELEASE}" \
         "  - Upstream FFmpeg:      https://github.com/FFmpeg/FFmpeg" \
         "    (the ffmpeg commit baked in is identified by the n7.1.x tag in" \
         "    the tarball name, e.g. n7.1.5-12-g1fdbca85aa -> g1fdbca85aa)" \
         > /out/PROVENANCE.txt \
    && rm -rf /tmp/ffmpeg-extract /tmp/ffmpeg.tar.xz

# ── Stage 1d: Build the Tailwind stylesheet over the FULL plugin set ──────
# The committed static/tailwind.min.css is generated against only the in-tree
# plugins. Rather than ship it as-is (leaving baked-in plugins' classes
# unstyled now that the Play CDN's runtime JIT is gone — feedBack#411),
# rebuild it here, after static/ + plugins/ are present, so the sheet covers
# whatever plugins are baked into the image. Runs in a throwaway node stage so
# this build-time toolchain never lands in the final image; the runtime node
# added later in the final stage (for on-install regeneration) is a separate,
# deliberate inclusion. Reuses the repo's tailwind.config.js (theme, safelist,
# highway_3d exclusion) for parity with scripts/build-tailwind.sh.
# (Runtime-installed plugins are handled separately by the server's rebuild.)
FROM node:22-slim AS tailwind-builder
WORKDIR /build
COPY tailwind.config.js ./
COPY static/ ./static/
COPY plugins/ ./plugins/
RUN npx -y tailwindcss@3.4.19 \
        -c tailwind.config.js \
        -i static/_tailwind.src.css \
        -o static/tailwind.min.css \
        --minify

# ── Stage 2: Final image ────────────────────────────────────────────────
FROM python:3.12-slim
# Re-declare the ffmpeg ARGs so their values are available to LABEL below.
# ARG values don't cross stage boundaries in multi-stage builds; defaults
# must be repeated here to take effect when no --build-arg is supplied.
# Keep these byte-identical to stage 1c — a build that pins a hash in the
# fetcher but advertises a different one in the labels is worse than useless.
ARG FFMPEG_RELEASE=autobuild-2026-07-31-14-10
ARG FFMPEG_BUILD_AMD64=ffmpeg-n7.1.5-12-g1fdbca85aa-linux64-gpl-7.1.tar.xz
ARG FFMPEG_BUILD_ARM64=ffmpeg-n7.1.5-12-g1fdbca85aa-linuxarm64-gpl-7.1.tar.xz
ARG FFMPEG_SHA256_AMD64=c1e6caf48923dd8e6bc5e54d51ba70c321175b8162ae9c414c392990e72f0e79
ARG FFMPEG_SHA256_ARM64=a9a50c5782ef5e45306d58d1a9a819015b472d8da30ab6a77f15f571c861a71b

# Apply latest security updates to base packages (clears glibc deb13u3 and
# similar). Done first so any subsequent installs resolve against the
# patched versions rather than the stale ones baked into the base image.
RUN apt-get update \
    && apt-get -y upgrade \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Runtime packages.
#
# NOTE: ffmpeg is intentionally NOT installed via apt. The apt `ffmpeg`
# package drags in the full codec + TLS + graphics dependency tree
# (mbedtls, gnutls28, mesa, x264, tiff, openjpeg2, libcaca, harfbuzz,
# cairo, openldap, libcdio…), almost all of which has unfixed CVEs and
# none of which FeedBack uses. We pull a static ffmpeg binary further
# down instead.
#
# vgmstream-cli is also built with -DUSE_FFMPEG=OFF (see stage 1b), so
# we don't need the libav* runtime libraries either — the Wwise Vorbis
# audio streams vgmstream handles are decoded natively. Dropping
# libav* also drops their transitive deps on mbedtls and gnutls28.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fluidsynth \
    fluid-soundfont-gm \
    libsndfile1 \
    # Runtime shared libraries for the natively-built vgmstream-cli.
    # `BUILD_SHARED_LIBS=OFF` in the builder stage only static-links
    # vgmstream's own libs; the external codec dependencies it linked
    # against (mpg123, vorbis, speex, opus) are still dynamic and need
    # their runtime packages here.
    libmpg123-0 \
    libvorbisfile3 \
    libspeex1 \
    libopus0 \
    # Shared libs the copied-in `node` binary links against. Normally present
    # transitively, but install explicitly so the runtime regeneration path
    # can't break with a dynamic-linker error if a future base/dep change stops
    # pulling them in.
    libstdc++6 \
    libgcc-s1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Node + the pinned Tailwind CLI for RUNTIME stylesheet regeneration. When a
# plugin is installed into FEEDBACK_PLUGINS_DIR at runtime (or discovered
# there on startup), the server rebuilds static/tailwind.min.css so the
# plugin's classes are styled — the image-baked sheet only covered in-tree
# plugins (see lib/tailwind_rebuild.py). tailwindcss is installed globally so
# the rebuild runs offline, with no npx fetch at install time. node/npm are
# copied from the existing tailwind-builder stage (same node:20-slim base) to
# avoid pulling that image a second time.
COPY --from=tailwind-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=tailwind-builder /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install -g tailwindcss@3.4.19 \
    && npm cache clean --force

# Static ffmpeg + ffprobe binaries from the throwaway fetcher stage above.
# BtbN GPL builds statically link their codec deps and don't pull in
# GnuTLS/mbedTLS, mesa, x264, cairo, etc. No CVE surface from the system
# codec stack; ~80 MB on disk.
#
# NOTE (GPL): the static ffmpeg binary is licensed under GPL v2+.
# LICENSE.txt from the BtbN tarball is copied into /usr/share/doc/ffmpeg/
# so the license text is present in the runtime image, and PROVENANCE.txt
# names the exact artefact plus where its corresponding source lives.
#
# If this image is redistributed publicly, the GPL requires that the
# Corresponding Source for this ffmpeg build also be made available.
# BtbN publishes full build configuration and source references at:
#   https://github.com/BtbN/FFmpeg-Builds  (tag: FFMPEG_RELEASE ARG)
# Ensure your redistribution method meets GPL conveyance requirements —
# either by pointing recipients to BtbN's source or by hosting it yourself.
COPY --from=ffmpeg-fetcher /out/ffmpeg /out/ffprobe /usr/local/bin/
COPY --from=ffmpeg-fetcher /out/LICENSE.txt /out/PROVENANCE.txt /usr/share/doc/ffmpeg/
RUN chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
# Record provenance so the exact BtbN source can be located for GPL compliance
# or debugging — the release tag plus the two hashes are what actually identify
# the bytes that shipped. Inspect with: docker inspect <image> | grep -A6 ffmpeg
LABEL org.feedBack.ffmpeg.release="${FFMPEG_RELEASE}" \
      org.feedBack.ffmpeg.source.amd64="${FFMPEG_BUILD_AMD64}" \
      org.feedBack.ffmpeg.source.arm64="${FFMPEG_BUILD_ARM64}" \
      org.feedBack.ffmpeg.sha256.amd64="${FFMPEG_SHA256_AMD64}" \
      org.feedBack.ffmpeg.sha256.arm64="${FFMPEG_SHA256_ARM64}" \
      org.feedBack.ffmpeg.upstream="https://github.com/BtbN/FFmpeg-Builds"

# Native vgmstream-cli built against the image's own libraries
COPY --from=vgmstream-builder /out/vgmstream-cli /usr/local/bin/vgmstream-cli
RUN chmod +x /usr/local/bin/vgmstream-cli

WORKDIR /app

# Upgrade pip itself before installing requirements — clears the pip CVEs
# (CVE-2025-8869, CVE-2026-6357, CVE-2026-1703) that ship with the base.
# Pinned for reproducibility; bump PIP_VERSION when a newer release is needed.
ARG PIP_VERSION=26.1.1
RUN pip install --no-cache-dir "pip==${PIP_VERSION}"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY lib/ /app/lib/
COPY static/ /app/static/
COPY plugins/ /app/plugins/
COPY data/ /app/data/
# Replace the committed sheet with the bundled-plugin-aware build from stage 1d.
COPY --from=tailwind-builder /build/static/tailwind.min.css /app/static/tailwind.min.css
# tailwind.config.js + _tailwind.src.css let the server regenerate the sheet
# when a plugin is installed at runtime (see update_manager on-install hook).
COPY tailwind.config.js /app/tailwind.config.js
COPY server.py /app/
COPY main.py /app/
COPY VERSION /app/
# Built-in diagnostic sloppaks seeded into DLC_DIR/diagnostics-builtin/ at scan
# time (_seed_builtin_diagnostic_sloppaks in server.py). server.py resolves the
# source relative to its own dir, so it must live under /app/docs/diagnostics/.
# Only the .sloppak artifacts are needed at runtime — not the builder script.
COPY docs/diagnostics/*.sloppak /app/docs/diagnostics/
# Starter packs are seeded from this path into DLC_DIR/starter/ on first run.
COPY content/starter/*.feedpak /app/content/starter/

ENV PYTHONPATH=/app/lib:/app

EXPOSE 8000

# main.py calls configure_logging() before uvicorn.run(..., log_config=None),
# which prevents uvicorn from applying its default dictConfig.  This ensures
# the structlog pipeline is active for ALL uvicorn messages — including the
# early lifecycle lines ("Started server process", "Waiting for application
# startup") that fire before the ASGI startup hook.
CMD python main.py
