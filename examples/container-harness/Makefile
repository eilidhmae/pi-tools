# Makefile for the pi-coding-agent Docker sandbox.
#
# Builds a Linux image whose user MATCHES the host user (name + uid + gid) so
# bind-mounted files keep correct ownership. The host MLX bank (the pi-tools
# `server/` track) is reached from the guest over the Docker host gateway via
# socat; generation is host-only (no Metal in the guest).
#
# Run logic lives in launch.sh. `make run`/`make shell` route there and resolve
# the project from the dir you invoke make in.

IMAGE     ?= pi-container-harness
USERNAME  ?= $(shell id -un)
UID       ?= $(shell id -u)
GID       ?= $(shell id -g)
# pi-tools repo root (this example lives at examples/container-harness/).
REPO_ROOT ?= $(abspath ../..)
export IMAGE

.PHONY: build run shell rebuild clean help

## build: stage the pi config + build the image for the current user
build:
	rm -rf .pi
	"$(REPO_ROOT)/install.sh" --local
	# install.sh --local stages the pi-tools agent into ./.pi/agent but does not
	# write a local-mlx models.json (the Apple-Silicon autodetect needs :18080 up,
	# which it is not at build time). Bake the provider map from the template so
	# the guest knows the 127.0.0.1:1808x endpoints the entrypoint forwards.
	cp "$(REPO_ROOT)/server/models.json.template" .pi/agent/models.json
	docker build \
	  --build-arg USERNAME="$(USERNAME)" \
	  --build-arg UID="$(UID)" \
	  --build-arg GID="$(GID)" \
	  -t "$(IMAGE)" \
	  -f Dockerfile .
	rm -rf .pi

## run: start the sandbox and drop into the RPI coordinator
run:
	./launch.sh

## shell: start the sandbox with an interactive bash shell instead of pi
shell:
	./launch.sh bash

## rebuild: build from scratch, then run
rebuild: build run

## clean: remove the built image
clean:
	docker image rm "$(IMAGE)" || true

## help: list targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## //'
