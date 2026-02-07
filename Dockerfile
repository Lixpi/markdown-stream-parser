# Set Node.js version
ARG NODE_VERSION=23

# Stage 1: Build
FROM node:${NODE_VERSION}-alpine

# Install necessary packages
RUN apk add --update --no-cache curl

# Install pnpm globally
RUN npm install -g pnpm

# Set the working directory
WORKDIR /usr/src/service

# Copy the rest of app's source code
COPY . .

# Install dependencies
RUN pnpm install --force && pnpm store prune && rm -rf ~/.pnpm-store

# Build the Svelte demo
WORKDIR /usr/src/service/demo/svelte-demo
RUN pnpm install --force
RUN pnpm run build
WORKDIR /usr/src/service

# Run the application
CMD ["pnpm", "run", "start"]
