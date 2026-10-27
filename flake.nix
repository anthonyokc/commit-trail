{
  description = "Follow one file's changes across GitHub pull requests in the terminal";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    bun2nix.url = "github:nix-community/bun2nix";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  nixConfig = {
    extra-substituters = [ "https://nix-community.cachix.org" ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      perSystem =
        { system, pkgs, lib, ... }:
        let
          bun2nix = inputs.bun2nix.packages.${system}.default;

          commit-trail = bun2nix.mkDerivation {
            pname = "commit-trail";
            version = (lib.importJSON ./package.json).version;

            src = ./.;
            module = "src/main.ts";

            bunDeps = bun2nix.fetchBunDeps { bunNix = ./bun.nix; };

            # Match `bun run build`: `bun build --compile --minify ./src/main.ts ./src/pierre-worker.ts`.
            # bun2nix defaults add --bytecode and --sourcemap, so drop them.
            bunCompileToBytecode = false;
            removeBunBuildFlags = [ "--sourcemap" ];
            # The executable embeds the syntax highlighting worker only when the build lists its entry point.
            extraBunBuildFlags = [ "src/pierre-worker.ts" ];

            nativeBuildInputs = [ pkgs.makeWrapper ];

            postInstall = ''
              wrapProgram $out/bin/commit-trail \
                --prefix PATH : ${lib.makeBinPath [ pkgs.gh pkgs.git ]}
            '';

            meta = {
              description = "Follow one file's changes across GitHub pull requests in the terminal";
              homepage = "https://github.com/anthonyokc/commit-trail";
              license = lib.licenses.mit;
              mainProgram = "commit-trail";
              platforms = [
                "x86_64-linux"
                "aarch64-linux"
                "aarch64-darwin"
              ];
            };
          };
        in
        {
          packages.default = commit-trail;
          packages.commit-trail = commit-trail;

          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.gh
              pkgs.git
              pkgs.delta
              bun2nix
            ];
          };
        };
    };
}
