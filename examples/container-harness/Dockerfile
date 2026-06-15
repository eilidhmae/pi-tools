# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# pi-coding-agent sandbox — Docker image for an Apple Silicon host running the
# pi-tools MLX bank.
# ---------------------------------------------------------------------------
# A Linux guest that runs pi-coding-agent and reaches the HOST's MLX inference
# servers (the pi-tools `server/` bank) over the Docker host gateway via socat
# (see entrypoint.sh). Generation happens on the host (no Metal in the guest);
# this container is a sandbox for the agent to work in.
#
#   * Host bind-mounts (the working dir, an optional memory store) are supplied
#     at RUN time by the launcher (see launch.sh / the Makefile), not by a
#     Dockerfile VOLUME.
#   * The guest user is created to MATCH the host user that builds the image —
#     name, uid, and gid — so files on the bind-mounted working dir keep correct
#     ownership. The Makefile fills the build args from `id`:
#       docker build --build-arg USERNAME=$(id -un) \
#                    --build-arg UID=$(id -u) --build-arg GID=$(id -g) ...
#     Home is /home/<user> (Linux convention): unlike Apple `container`, Docker
#     does not rewrite the guest home to the host path, so a memory store is
#     mounted under this /home/<user> at run time.
#
# Layers are ordered cheapest/most-stable first so iterating rebuilds little:
#   apt -> pip -> node/socat -> pi install -> requirements.txt -> pi config.
# ---------------------------------------------------------------------------

FROM python:3.12-slim

# Host identity, passed by the Makefile (defaults are harmless fallbacks).
ARG USERNAME=pi
ARG UID=1000
ARG GID=1000

# System deps: curl for the node installer, git + image libs for the ML stack.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        curl \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --upgrade pip

# Node.js 22 (pi requires >=22.19.0) + socat (the entrypoint forwards the
# guest's localhost to the host inference bank). NodeSource ships node + npm.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs socat \
    && rm -rf /var/lib/apt/lists/*

# Host-matched user. Create the group only if its gid is free (host gids such as
# 20/staff collide with existing Debian groups — ownership matching is by numeric
# id, so reusing the existing group is correct). Home at /home/<user>.
RUN if ! getent group "$GID" >/dev/null 2>&1; then groupadd -g "$GID" "$USERNAME"; fi \
    && useradd -u "$UID" -g "$GID" -m -d "/home/$USERNAME" -s /bin/bash "$USERNAME"

# $HOME/.pi config, HF cache, and the socat forward list. PI_CONTAINER=1 marks
# the session as containerized (a mounted memory store is then read-only).
ENV HOME=/home/$USERNAME \
    HF_HOME=/home/$USERNAME/models \
    PATH=/home/$USERNAME/.local/bin:$PATH \
    HOST_FORWARD_PORTS="18080 18090 18100 18110 18111 18120 18130" \
    PI_CONTAINER=1

# pi via npm (the interactive pi.dev installer bails in a non-TTY build). Before
# any project files so neither code nor requirements edits re-trigger it.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Entrypoint forwards the guest's 127.0.0.1:1808x to the host gateway so pi's
# 127.0.0.1-pointed config reaches the host MLX bank. In /usr/local/bin so a
# run-time mount over the workdir cannot shadow it.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Extra Python packages: edit requirements.txt and rebuild (busts only this layer).
COPY requirements.txt /opt/harness/requirements.txt
RUN pip install --no-cache-dir -r /opt/harness/requirements.txt

# Staged pi config: the Makefile runs `install.sh --local` into ./.pi (the
# pi-tools agent: skills, extensions, workers, scripts) and bakes the harness
# models.json, then docker build copies it here. chown via a separate RUN —
# not `COPY --chown=$ARG`, which only interpolates build args under BuildKit —
# so the build also works on the legacy builder / older Docker Engine.
COPY .pi /home/$USERNAME/.pi
RUN chown -R "$UID:$GID" /home/$USERNAME/.pi

WORKDIR /opt/harness
USER $USERNAME

# Plain `docker run -it <image>` drops into the RPI coordinator in the workspace
# (the launcher adds the --tools surface; see launch.sh). The entrypoint starts
# the host-port forwarder first, then execs the command. Append `bash` for a
# shell. Default model is the 30B-A3B base the 32 GB host serves on :18080 —
# override with the CMD or PI_MODEL/PI_PROVIDER via the launcher.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["pi","--provider","local-mlx","--model","qwen3-coder-30b-a3b"]
