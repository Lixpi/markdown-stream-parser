# Set Node.js version
ARG NODE_VERSION=23

# Stage 1: Build - use slim (Debian) for Emscripten compatibility
# Alpine uses musl which is incompatible with emsdk binaries
FROM node:${NODE_VERSION}-slim

# Install necessary packages
# tree-sitter needs C/C++ compiler (g++, make) and python3
# cargo is needed to install tree-sitter-cli from source
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl python3 make g++ git xz-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Rust and Cargo
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install pnpm globally
RUN npm install -g pnpm

# Install tree-sitter-cli from source via cargo
# Pin version to 0.25.0
RUN cargo install --locked --version 0.25.0 tree-sitter-cli

# Install Emscripten SDK for WASM compilation
RUN git clone https://github.com/emscripten-core/emsdk.git /opt/emsdk \
    && cd /opt/emsdk \
    && ./emsdk install latest \
    && ./emsdk activate latest
ENV EMSDK="/opt/emsdk"
ENV PATH="/opt/emsdk:/opt/emsdk/upstream/emscripten:/opt/emsdk/node/22.16.0_64bit/bin:${PATH}"

# Set environment variables for C++ compilation
ENV CXXFLAGS="-std=c++20 -fexceptions"
ENV CXX="g++ -std=c++20 -fexceptions"

# Set the working directory
WORKDIR /usr/src/service

# Copy the rest of app's source code
COPY . .

# Install dependencies
RUN pnpm install --force && pnpm store prune && rm -rf ~/.pnpm-store

# Build tree-sitter WASM files
RUN chmod +x scripts/build-wasm.sh && scripts/build-wasm.sh

# Build the Svelte demo
WORKDIR /usr/src/service/demo/svelte-demo
RUN pnpm install --force
RUN pnpm run build
WORKDIR /usr/src/service

# Run the application
CMD ["pnpm", "run", "start"]
