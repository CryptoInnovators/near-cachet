# source from the repo root. Keeps cargo output off the source tree when CARGO_TARGET_DIR is unset.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)/target}"
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
