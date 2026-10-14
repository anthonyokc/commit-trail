class CommitTrail < Formula
  desc "Follow each file's changes across GitHub pull requests in the terminal"
  homepage "https://github.com/anthonyokc/commit-trail"
  url "https://github.com/anthonyokc/commit-trail.git", tag: "v0.1.0", using: :git
  version "0.1.0"
  head "https://github.com/anthonyokc/commit-trail.git", branch: "main", using: :git

  depends_on "bun" => :build
  depends_on "gh"

  def install
    system "bun", "install", "--frozen-lockfile"
    system "bun", "build", "--compile", "--minify", "src/main.ts", "--outfile", "commit-trail"
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
