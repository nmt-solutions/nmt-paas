FROM node:22-alpine

RUN apk add --no-cache \
    git \
    docker-cli \
    bash

WORKDIR /workspace