# Claude0-owned shell integration. Prompt, aliases, history, completion, and other
# interactive behavior belong to dotfiles.

# Make the installed Claude0 command and its Bun runtime available without taking
# ownership of the rest of the user's PATH.
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
