# CSM-owned shell integration. Installed by `csm setup` and sourced by ~/.zshrc.

export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# A Linux CSM host deliberately has no dependency on the macOS dotfiles repo.
# Provide a compact interactive baseline; users can extend it in ~/.zshrc.local.
if [[ "$OSTYPE" != darwin* ]]; then
  setopt auto_cd share_history hist_ignore_all_dups hist_save_no_dups
  cdpath=("$HOME/Documents")
  HISTSIZE=10000
  SAVEHIST=$HISTSIZE
  HISTFILE="$HOME/.zsh_history"
  bindkey -e
  autoload -Uz colors && colors
  PROMPT='%F{green}%n@%m%f %F{blue}%~%f %# '
  alias ls='ls -la --color=auto'
  alias cc='claude'
  [[ -r "$HOME/.zshrc.local" ]] && source "$HOME/.zshrc.local"
fi

# Explicit local/remote entry points. `csm-mode local|remote` changes what a new
# Ghostty surface opens; `vm` always opens the configured remote host.
alias csm-local='$HOME/.local/bin/csm-terminal local'
alias csm-remote='$HOME/.local/bin/csm-terminal remote'
alias csm-mode='$HOME/.local/bin/csm-terminal use'
alias csm-terminal-status='$HOME/.local/bin/csm-terminal status'
alias vm='$HOME/.local/bin/csm-terminal remote'
