# Set Node.js version
ARG NODE_VERSION=23

# Stage 1: Build
FROM node:${NODE_VERSION}-alpine

# Install necessary packages
# tree-sitter needs C/C++ compiler (g++, make) and python3
# cargo is needed to install tree-sitter-cli from source because npm install fails due to network/SSL issues with GitHub releases in this environment
RUN apk add --update --no-cache curl python3 make g++ cargo

# Install pnpm globally
RUN npm install -g pnpm

# Install tree-sitter-cli from source via cargo (bypassing GitHub releases download issue)
# Pin version to 0.25.0 to avoid dependency on libloading 0.9.0 which requires newer Rust than available in node:23-alpine
RUN cargo install --locked --version 0.25.0 tree-sitter-cli
ENV PATH="/root/.cargo/bin:${PATH}"

# Set environment variables for C++ compilation
ENV CXXFLAGS="-std=c++20 -fexceptions"
ENV CXX="g++ -std=c++20 -fexceptions"

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
