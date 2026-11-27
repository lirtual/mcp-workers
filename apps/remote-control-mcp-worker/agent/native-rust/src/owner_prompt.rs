//! Shared attended Owner confirmation for local native CLI commands.
use std::io::{self, IsTerminal, Write};

fn affirmative(answer: &str) -> bool {
    matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

/// Require an explicit affirmative response from an interactive terminal.
pub fn confirm(prompt: &str) -> Result<bool, ()> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(());
    }
    print!("{prompt} [y/N]: ");
    io::stdout().flush().map_err(|_| ())?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer).map_err(|_| ())?;
    Ok(affirmative(&answer))
}

#[cfg(test)]
mod tests {
    use super::affirmative;

    #[test]
    fn only_explicit_affirmative_answers_confirm() {
        for value in ["y", "Y", "yes", "YES", " Yes\r\n"] {
            assert!(affirmative(value));
        }
        for value in [
            "",
            "\n",
            "n",
            "no",
            "CONFIRM TARGET",
            "AUTHORIZE PRODUCTION",
            "other",
        ] {
            assert!(!affirmative(value));
        }
    }
}
