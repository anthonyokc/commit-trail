class CommitTrail < Formula
  desc "Follow each file's changes across GitHub pull requests in the terminal"
  homepage "https://github.com/anthonyokc/commit-trail"
  url "https://github.com/anthonyokc/commit-trail.git", tag: "v0.2.0", using: :git
  version "0.2.0"
  license "MIT"
  head "https://github.com/anthonyokc/commit-trail.git", branch: "main", using: :git

  depends_on "gh"

  # Bun builds the standalone executable. The formula downloads a pinned Bun release instead of
  # depending on a Bun formula, so it works next to either homebrew/core/bun or oven-sh/bun/bun.
  resource "bun" do
    on_macos do
      on_arm do
        url "https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-darwin-aarch64.zip"
        sha256 "6f5a3467ed9caec4795bf78cd476507d9f870c7d57b86c945fcb338126772ffc"
      end
      on_intel do
        url "https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-darwin-x64.zip"
        sha256 "c4fe2b9247218b0295f24e895aaec8fee62e74452679a9026b67eacbd611a286"
      end
    end
    on_linux do
      on_arm do
        url "https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-linux-aarch64.zip"
        sha256 "d13944da12a53ecc74bf6a720bd1d04c4555c038dfe422365356a7be47691fdf"
      end
      on_intel do
        url "https://github.com/oven-sh/bun/releases/download/bun-v1.3.11/bun-linux-x64.zip"
        sha256 "8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed"
      end
    end
  end

  def install
    resource("bun").stage { (buildpath/"build-tools").install "bun" }
    bun = buildpath/"build-tools/bun"
    chmod 0755, bun
    system bun, "install", "--frozen-lockfile"
    system bun, "build", "--compile", "--minify", "src/main.ts", "--outfile", "commit-trail"
    bin.install "commit-trail"
  end

  def caveats
    <<~EOS
      commit-trail reads pull request metadata through the GitHub CLI.
      If you have not signed in, run:
        gh auth login
      The `o` key opens pull requests in tuicr. To use it, install tuicr:
        brew install tuicr
    EOS
  end

  test do
    assert_match "commit-trail #{version}", shell_output("#{bin}/commit-trail --version")
    system "git", "init", "-q", testpath/"repo"
    output = shell_output("#{bin}/commit-trail report 1:x --repo #{testpath}/repo 2>&1", 1)
    assert_match "Invalid pull request selection", output
  end
end
