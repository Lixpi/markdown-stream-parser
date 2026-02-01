#!/bin/sh
# Build tree-sitter WASM files for markdown parsing
# This script is run during Docker container startup (when using volume mounts)
# or during Docker image build

set -e

# Force temp files to /tmp to avoid cross-device link issues with Docker volume mounts
export TMPDIR=/tmp
export TEMP=/tmp
export TMP=/tmp

echo "Building tree-sitter WASM files..."

# Source emsdk environment if available (for emsdk-based setup)
if [ -f "/opt/emsdk/emsdk_env.sh" ]; then
    echo "Sourcing emsdk environment..."
    export EMSDK="/opt/emsdk"
    cd /opt/emsdk
    . ./emsdk_env.sh
    # Explicitly add emscripten to PATH since source may not persist in sh
    export PATH="/opt/emsdk:/opt/emsdk/upstream/emscripten:$PATH"
    cd /usr/src/service
fi

# Verify emcc is available (POSIX compatible check)
if ! command -v emcc > /dev/null 2>&1; then
    echo "Error: emcc not found in PATH. Please install emscripten."
    echo "Current PATH: $PATH"
    exit 1
fi
echo "Using emcc: $(command -v emcc)"

# Find the tree-sitter-markdown package directory
# pnpm may move packages to .ignored/ or .pnpm/ folders
MARKDOWN_PKG_DIR=$(find node_modules -path "*tree-sitter-grammars*tree-sitter-markdown" -type d | grep -v node_modules/.pnpm | head -1)

if [ -z "$MARKDOWN_PKG_DIR" ]; then
    echo "Error: @tree-sitter-grammars/tree-sitter-markdown package not found"
    exit 1
fi

echo "Found tree-sitter-markdown at: $MARKDOWN_PKG_DIR"

# Output directory
OUTPUT_DIR="demo/svelte-demo/static"
mkdir -p "$OUTPUT_DIR"

# Create temp build directory to avoid cross-device link issues with Docker volume mounts
# tree-sitter CLI uses rename() internally which fails across filesystems
BUILD_TMP="/tmp/tree-sitter-wasm-build"
rm -rf "$BUILD_TMP"
mkdir -p "$BUILD_TMP/grammars"

# Copy grammar sources to temp directory (avoid mount issues during build)
cp -r "$MARKDOWN_PKG_DIR/tree-sitter-markdown" "$BUILD_TMP/grammars/"
cp -r "$MARKDOWN_PKG_DIR/tree-sitter-markdown-inline" "$BUILD_TMP/grammars/"

# Create tree-sitter.json config files in grammar directories
# Create config for tree-sitter-markdown (block grammar)
cat > "$BUILD_TMP/grammars/tree-sitter-markdown/tree-sitter.json" << 'EOF'
{
  "metadata": {
    "version": "0.3.2",
    "license": "MIT",
    "description": "Markdown block grammar for tree-sitter"
  },
  "grammars": [
    {
      "name": "markdown",
      "scope": "text.markdown",
      "path": ".",
      "file-types": ["md"]
    }
  ],
  "bindings": {
    "c": false
  }
}
EOF

# Create config for tree-sitter-markdown-inline
cat > "$BUILD_TMP/grammars/tree-sitter-markdown-inline/tree-sitter.json" << 'EOF'
{
  "metadata": {
    "version": "0.3.2",
    "license": "MIT",
    "description": "Markdown inline grammar for tree-sitter"
  },
  "grammars": [
    {
      "name": "markdown_inline",
      "scope": "text.markdown_inline",
      "path": "."
    }
  ],
  "bindings": {
    "c": false
  }
}
EOF

# Build tree-sitter-markdown.wasm (block-level grammar)
echo "Building tree-sitter-markdown.wasm..."
cd "$BUILD_TMP/grammars/tree-sitter-markdown"
pwd >&2
ls -la >&2
echo "DEBUG: About to run tree-sitter build, pwd=$(pwd)" >&2
sync
tree-sitter build --wasm -o "$BUILD_TMP/tree-sitter-markdown.wasm"

# Build tree-sitter-markdown-inline.wasm (inline grammar)
echo "Building tree-sitter-markdown-inline.wasm..."
cd "$BUILD_TMP/grammars/tree-sitter-markdown-inline"
pwd >&2
sync
tree-sitter build --wasm -o "$BUILD_TMP/tree-sitter-markdown-inline.wasm"

# Copy built WASM files to output directory
cd /usr/src/service
cp "$BUILD_TMP/tree-sitter-markdown.wasm" "$OUTPUT_DIR/"
cp "$BUILD_TMP/tree-sitter-markdown-inline.wasm" "$OUTPUT_DIR/"

# Copy tree-sitter.wasm runtime if it exists
if [ -f "node_modules/web-tree-sitter/tree-sitter.wasm" ]; then
    cp "node_modules/web-tree-sitter/tree-sitter.wasm" "$OUTPUT_DIR/"
fi

# Cleanup temp directory
rm -rf "$BUILD_TMP"

echo "WASM files built successfully:"
ls -la "$OUTPUT_DIR"/*.wasm
