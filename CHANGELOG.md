# Changelog

## [1.6.0](https://github.com/wyattjoh/stacked-prs/compare/stacked-prs-v1.5.0...stacked-prs-v1.6.0) (2026-04-14)


### Features

* **cli:** add pr, submit, and sync subcommands mirroring Graphite ([199b110](https://github.com/wyattjoh/stacked-prs/commit/199b1108db2af65e3c760a8408c0649d56178789))

## [1.5.0](https://github.com/wyattjoh/stacked-prs/compare/stacked-prs-v1.4.0...stacked-prs-v1.5.0) (2026-04-14)


### Features

* **nav:** preserve merged PRs in nav history via landed-pr config ([814dfe7](https://github.com/wyattjoh/stacked-prs/commit/814dfe7924f58eef212e9647dd691fe4b0c8a4ba))

## [1.4.0](https://github.com/wyattjoh/stacked-prs/compare/stacked-prs-v1.3.1...stacked-prs-v1.4.0) (2026-04-14)


### Features

* **clean:** flag legacy stack-merged on live branches ([2ff4bfb](https://github.com/wyattjoh/stacked-prs/commit/2ff4bfb5bf6428809549291b7146d037799d7909))
* **cli:** wire up create subcommand with TTY prompt ([2150223](https://github.com/wyattjoh/stacked-prs/commit/2150223a35b3bf949a5fccc05bef4dc8b8b0b394))
* **config:** propagate tombstones to split stacks and clean up original ([a29c38d](https://github.com/wyattjoh/stacked-prs/commit/a29c38df12e14e14e53dfeb6ec480344b2b493ee))
* **config:** write stack-level tombstone in configLandCleanup ([03fb5f9](https://github.com/wyattjoh/stacked-prs/commit/03fb5f90243505e95e0a10a1ff03b215b86d6960))
* **create:** implement case 1 (child in existing stack) ([ad15756](https://github.com/wyattjoh/stacked-prs/commit/ad15756f232a286e10a625e015903975956b994d))
* **create:** implement case 2 (auto-init in-repo) ([6b59b0c](https://github.com/wyattjoh/stacked-prs/commit/6b59b0c827e711e57295a4e54884c0766ab7406e))
* **create:** implement case 3 (auto-init worktree) ([59ae127](https://github.com/wyattjoh/stacked-prs/commit/59ae12773430c4fc5d6de17c0a71d8771e8a6540))
* **create:** include executed commands in --dry-run output and SKILL flow ([ad03736](https://github.com/wyattjoh/stacked-prs/commit/ad03736d64903918bfc096cfe86603ccc8ff89b3))
* **create:** scaffold command types and stub entry points ([0868555](https://github.com/wyattjoh/stacked-prs/commit/0868555914d43a988d5bfbc070c18348431f3544))
* **land:** add isBranchAutoMerged helper and autoMerged resume field ([057be4b](https://github.com/wyattjoh/stacked-prs/commit/057be4b0e052aedab12746f3b2defd2148fa7020))
* **land:** close PR and skip retarget for auto-merged CLI branches ([6f766d7](https://github.com/wyattjoh/stacked-prs/commit/6f766d70a2a41d95b6f9972675ce2dd75b9e0f92))
* **land:** delete and tombstone auto-merged branches in CLI path ([9f2be30](https://github.com/wyattjoh/stacked-prs/commit/9f2be30d20e3552c396b3db83677cddfd73431d2))
* **land:** detect auto-merged branches in CLI rebase loop ([a447d70](https://github.com/wyattjoh/stacked-prs/commit/a447d70a07c9de0140a91601209f15d359fb568c))
* **land:** skip push for auto-merged branches in CLI path ([0a591c9](https://github.com/wyattjoh/stacked-prs/commit/0a591c916a13474dea959c44b53b964abb0b98c2))
* **land:** surface auto-merged branches in CLI result ([fd7bcbc](https://github.com/wyattjoh/stacked-prs/commit/fd7bcbcaed804346d64bb1498f807915b6a27928))
* **lib:** add detectDefaultBranch helper ([2e380e7](https://github.com/wyattjoh/stacked-prs/commit/2e380e7876def73ecc80b67f6c68b5b00b71947d))
* **stack:** add addLandedBranch and getLandedBranches helpers ([26a8917](https://github.com/wyattjoh/stacked-prs/commit/26a8917e7600d93773b09606e0529d615fd97d36))
* **stack:** reconstruct merged roots from stack-level tombstones in getStackTree ([ac6a741](https://github.com/wyattjoh/stacked-prs/commit/ac6a741ac9b26ba97dce95c70e619ed77dc86c93))


### Bug Fixes

* **land:** clear landed-branches config in all-merged cleanup paths ([e9c091f](https://github.com/wyattjoh/stacked-prs/commit/e9c091feb16ef70fa4b520393b18506192fbccf0))
* **land:** close crash window between rebase complete and auto-merge flag ([ba1ca7f](https://github.com/wyattjoh/stacked-prs/commit/ba1ca7fd5ea1d0ce693b42db7d47ceb742a592cb))
* **land:** match TUI auto-merged semantics against rebase target ([d6f8683](https://github.com/wyattjoh/stacked-prs/commit/d6f868395d3d687d1c1b955c3d30cd64f43f5d80))
* **land:** re-check auto-merged on pre-migration resume state ([5cbf749](https://github.com/wyattjoh/stacked-prs/commit/5cbf7490b700909268fd092f1a02b75f32889943))
* **land:** tombstone before delete and gate on branch -D exit ([36c0a7b](https://github.com/wyattjoh/stacked-prs/commit/36c0a7b239614c256aff7e14bb7f3145586e9cb7))
* **land:** tombstone before delete in TUI executor ([2ae0154](https://github.com/wyattjoh/stacked-prs/commit/2ae0154e84b05969d2176d8a79ab3c26c9c29c3e))
* **land:** tombstone deleted branches in CLI root-merged path ([16ded69](https://github.com/wyattjoh/stacked-prs/commit/16ded69cfdca110eabf5c6d999361d1aefd3d972))
* **land:** tombstone every deleted branch in case A cleanup loop ([acb6401](https://github.com/wyattjoh/stacked-prs/commit/acb6401c09ec79430841a719109eb0c7cb2eaf5b))
* **land:** wrap auto-merged PR close in try/catch with resume guidance ([e679183](https://github.com/wyattjoh/stacked-prs/commit/e6791835fce47bc092b913da41b073d912d2aff0))
* **stack:** throw on addLandedBranch failure, expand tests and deprecation notice ([36375cd](https://github.com/wyattjoh/stacked-prs/commit/36375cd1e41da5d7a856b4a44f3db03e9afb22fd))

## [1.3.1](https://github.com/wyattjoh/stacked-prs/compare/stacked-prs-v1.3.0...stacked-prs-v1.3.1) (2026-04-13)


### Bug Fixes

* **land:** use resolveRepo() to correctly extract owner string ([fffeb53](https://github.com/wyattjoh/stacked-prs/commit/fffeb534ca039f557d400eebab0bd6cfad51f8f5))

## [1.3.0](https://github.com/wyattjoh/stacked-prs/compare/stacked-prs-v1.2.4...stacked-prs-v1.3.0) (2026-04-12)


### Features

* **tui:** show * indicator next to the current branch ([db73abc](https://github.com/wyattjoh/stacked-prs/commit/db73abc717364666b16744d0ac0cc7259d9f83e2))

## [1.2.4](https://github.com/wyattjoh/stacked-prs/compare/stacked-prs-v1.2.3...stacked-prs-v1.2.4) (2026-04-12)


### Bug Fixes

* address launch readiness issues from code review ([96faac5](https://github.com/wyattjoh/stacked-prs/commit/96faac55236037b01eb69cc3949eeec0dbd9bd33))

## [1.2.3](https://github.com/wyattjoh/stacked-prs/compare/stacked-prs-v1.2.2...stacked-prs-v1.2.3) (2026-04-12)


### Bug Fixes

* **cli:** read version from plugin.json instead of hardcoded string ([9ffa894](https://github.com/wyattjoh/stacked-prs/commit/9ffa894b20c7e8862f2b4659eaee13e1aea42a9d))

## [1.2.2](https://github.com/wyattjoh/stacked-prs/compare/stacked-prs-v1.2.1...stacked-prs-v1.2.2) (2026-04-12)


### Bug Fixes

* **ci:** move homebrew and marketplace jobs into release workflow ([0226d39](https://github.com/wyattjoh/stacked-prs/commit/0226d39d303393e19014526825fe0946eb31b1a3))

## [1.2.1](https://github.com/wyattjoh/stacked-prs/compare/stacked-prs-v1.2.0...stacked-prs-v1.2.1) (2026-04-12)


### Bug Fixes

* **ci:** use release published trigger for homebrew and marketplace workflows ([eb343a7](https://github.com/wyattjoh/stacked-prs/commit/eb343a7e22310f21cad25ac73a7f98d39c2f9633))

## [1.2.0](https://github.com/wyattjoh/stacked-prs/compare/stacked-prs-v1.1.0...stacked-prs-v1.2.0) (2026-04-11)


### Features

* add compile:macos and compile:linux tasks for binary distribution ([da7b7cd](https://github.com/wyattjoh/stacked-prs/commit/da7b7cd214dd45dc1bdf93490921c588623792d4))
* add tag-triggered Homebrew binary release workflow ([91f398f](https://github.com/wyattjoh/stacked-prs/commit/91f398fc407b11b743cc68e66f9608bc80be3b8a))
* **cli:** add land subcommand with --dry-run, --json, --resume flags ([b1fefb5](https://github.com/wyattjoh/stacked-prs/commit/b1fefb56944cb035657b3115f661210f229b35a8))
* **config:** defer branch config removal on land; set stack-merged flag instead ([819c985](https://github.com/wyattjoh/stacked-prs/commit/819c985e1f0a46e1590012273c7debcfa348c38a))
* **land:** add LandResumeState and executeLandFromCli with conflict pause/resume ([a58967f](https://github.com/wyattjoh/stacked-prs/commit/a58967f8c9e5901eb89fe9db513f8401b7b1169a))
* **land:** filter historical merged nodes from classifyLandCase and planLand ([631ca77](https://github.com/wyattjoh/stacked-prs/commit/631ca7785e42e7e47b31f4984f3ec3ab3c413e8f))
* **nav:** render stack-merged branches as strikethrough in nav comments ([e293375](https://github.com/wyattjoh/stacked-prs/commit/e29337519ed82dc6a982784661ed301a34980b59))
* **restack:** skip stack-merged nodes in topologicalOrder ([6db5ed5](https://github.com/wyattjoh/stacked-prs/commit/6db5ed583fcab393d8a14241e8b6735374102beb))
* **stack:** add merged field to StackNode; read stack-merged from git config ([d250bf8](https://github.com/wyattjoh/stacked-prs/commit/d250bf82c5a034a967fdbbb4367f4cece1f14e1f))
* **status:** return 'landed' sync status for stack-merged branches ([370d19d](https://github.com/wyattjoh/stacked-prs/commit/370d19daa16f25f27acdb7efe1ad1fa0ca13bdfe))
* **tui/land-modal:** add ↑/↓ scroll to land modal ([b8d12ee](https://github.com/wyattjoh/stacked-prs/commit/b8d12ee4b1c60320ea180d1cb6987934621ffe01))
* **tui/land-modal:** show rollback commands executed on failure ([6698aae](https://github.com/wyattjoh/stacked-prs/commit/6698aae721a3a5f014dd5558252d3bbb51bab48f))
* **tui/layout:** add merged field to GridCell; walk merged roots before live roots ([520722d](https://github.com/wyattjoh/stacked-prs/commit/520722d92575ac02d96591c99d1d602d911cfd02))
* **tui/loader:** skip sync computation for stack-merged nodes; set 'landed' ([45e4eb4](https://github.com/wyattjoh/stacked-prs/commit/45e4eb4b843957820447ffd4f60ebe3924483280))
* **tui/scroll:** account for merged cell gap rows in measureLayout ([fda1c00](https://github.com/wyattjoh/stacked-prs/commit/fda1c0017222578a293cd72ef2fedae23e7a85ad))
* **tui/stack-band:** render merged cells dimmed with gap rows; no connector ([939c0ba](https://github.com/wyattjoh/stacked-prs/commit/939c0ba0e20d3a7b27c5a9c2c6a719d960f5f5ab))


### Bug Fixes

* **homebrew:** add concurrency guard and fail-fast: false to release workflow ([2c03354](https://github.com/wyattjoh/stacked-prs/commit/2c033544aad57ac63b07d9c2c0047969d9f25910))
* **tests:** bypass Ink CI suppression and set no-op editor in test repos ([6531629](https://github.com/wyattjoh/stacked-prs/commit/6531629493afd392758fd64939511b66ebfb9a06))
* **tests:** resolve CI environment failures ([daf4bd2](https://github.com/wyattjoh/stacked-prs/commit/daf4bd2370bff7ebe0e2aa5757d86a7664a9d730))
* **tests:** use debug:true in narrow nav tests to bypass Ink CI suppression ([552f6ea](https://github.com/wyattjoh/stacked-prs/commit/552f6ea2036eaa8ef7bd257fddadacce90bd6f4a))
* **tui/land-modal:** hide rollback section when nothing was rolled back ([90d6daa](https://github.com/wyattjoh/stacked-prs/commit/90d6daa6ec6c72c17723b91cb3762dbbb4f59000))
* **tui/stack-band:** use separate code path for non-merged stacks to avoid Ink height regression ([5dffc02](https://github.com/wyattjoh/stacked-prs/commit/5dffc02be3b3e662000df7af999dedac84665f01))
* **worktrees:** skip the operating worktree instead of always skipping the primary ([b008127](https://github.com/wyattjoh/stacked-prs/commit/b008127197bf1174f38179f354ce91448d429822))

## [1.1.0](https://github.com/wyattjoh/stacked-prs/compare/stacked-prs-v1.0.0...stacked-prs-v1.1.0) (2026-04-09)


### Features

* **clean:** add command to detect and remove stale stack config ([d6b8034](https://github.com/wyattjoh/stacked-prs/commit/d6b8034262fd617d6f1aad51ca0696fd0c7d399c))
* **clean:** color CLI output by stack using shared TUI palette ([0b978dd](https://github.com/wyattjoh/stacked-prs/commit/0b978dd9eebcdfaded25ddddd724ff8583e68bf4))
* **cli:** add -i/--interactive flag to status command ([d1d08f3](https://github.com/wyattjoh/stacked-prs/commit/d1d08f33b4625b4d577d057b658d32b8ef24d403))
* **gh:** accept optional AbortSignal for cancellation ([7e5a8f6](https://github.com/wyattjoh/stacked-prs/commit/7e5a8f60913a429fba3ec1be2e5907f050c16139))
* initial stacked-prs Claude Code plugin ([906a46b](https://github.com/wyattjoh/stacked-prs/commit/906a46ba40c063c0fbb6b7b99805daf6ca8fbdd1))
* **land:** add shallow repository detection ([79eb2ea](https://github.com/wyattjoh/stacked-prs/commit/79eb2ea617c669a54cb0c819fc78d8cafa6cdaff))
* **land:** add types module for land library ([7598a94](https://github.com/wyattjoh/stacked-prs/commit/7598a946c6b39af83e3ffed3f94da3a5cbc0baa5))
* **land:** add unified land preflight check ([ba20bcf](https://github.com/wyattjoh/stacked-prs/commit/ba20bcf8b2e495c09a0de15e5c32f994d3d18c22))
* **land:** auto-remove clean linked worktrees before landing ([6d08adc](https://github.com/wyattjoh/stacked-prs/commit/6d08adc01d20dc3e2c517964798e219b6410a3f9))
* **land:** build per-branch rebase and push steps ([8858f5d](https://github.com/wyattjoh/stacked-prs/commit/8858f5d09cfce3c4d85f7df8c8c075842cd09dd0))
* **land:** build PR base-retarget and ready-flip steps ([002d4b0](https://github.com/wyattjoh/stacked-prs/commit/002d4b0efaac7b094e130ae0d329af6772a76eb9))
* **land:** capture branch and HEAD snapshots ([cc18413](https://github.com/wyattjoh/stacked-prs/commit/cc18413d18ea58512c42f43708905ec19a43396e))
* **land:** classify supported land shapes ([f7fe33d](https://github.com/wyattjoh/stacked-prs/commit/f7fe33d704725a16294a5942720e60dbef65d1aa))
* **land:** close PRs for auto-merged branches ([0c7d8f3](https://github.com/wyattjoh/stacked-prs/commit/0c7d8f3db694ab0b720c255f954977a46ace0efd))
* **land:** config cleanup, branch delete, and HEAD restore ([5d28b2b](https://github.com/wyattjoh/stacked-prs/commit/5d28b2b06dcf1b6466d2d401d13c17e9e590d023))
* **land:** execute case A rebase phase with snapshot rollback ([4420c33](https://github.com/wyattjoh/stacked-prs/commit/4420c33d75059e16d2d261b7b2ee77f835d6b450))
* **land:** executeLand fast-path for all-merged stacks ([300e4ba](https://github.com/wyattjoh/stacked-prs/commit/300e4ba7f4a5f2af4bcbb27572ae137a178bb05b))
* **land:** fetch base branch before case A rebases ([e4747d6](https://github.com/wyattjoh/stacked-prs/commit/e4747d64f2db127c5c5044089c65752d7707229d))
* **land:** orchestrate planLand for both cases ([c44a42a](https://github.com/wyattjoh/stacked-prs/commit/c44a42a401d82881e60fc9234839b64fd1d076bf))
* **land:** PR base retarget and ready flip with rollback ([527521e](https://github.com/wyattjoh/stacked-prs/commit/527521e3139f532c96d32a067a47529cac595e3c))
* **land:** preview land cleanup and splits ([d1f665c](https://github.com/wyattjoh/stacked-prs/commit/d1f665c6d79556f2ab6f49b7f9f0c0982ce3c828))
* **land:** push phase with lease-based rollback ([43ce8fe](https://github.com/wyattjoh/stacked-prs/commit/43ce8fe73121a7bb827befd6131319ccfff2171e))
* **land:** re-read PR states before mutation to catch stale plans ([fc15279](https://github.com/wyattjoh/stacked-prs/commit/fc152795dd3463361526b1b7a02a4259208950a1))
* **land:** refresh nav comments after land ([ccc2577](https://github.com/wyattjoh/stacked-prs/commit/ccc25778e4d5a7a9d2f947689721521aa9822ef3))
* **lib:** add worktree safety reader for sync pre-flight ([4169916](https://github.com/wyattjoh/stacked-prs/commit/41699160bc8f33ff0ad3005d50c88cbbb7dcb129))
* **release:** add release-please workflow with marketplace publishing ([17297f1](https://github.com/wyattjoh/stacked-prs/commit/17297f138b27c54733105cc96897a322cbafcbbd))
* **restack:** add dry-run planner with old-parent-sha snapshot ([15eb6a4](https://github.com/wyattjoh/stacked-prs/commit/15eb6a4d091d3a82576d7ff1fd66dd46bb46ed6a))
* **restack:** add new types and topological walker ([966408c](https://github.com/wyattjoh/stacked-prs/commit/966408c38304f8218c92ac82beda3897488ed7ed))
* **restack:** continue independent siblings when one branch conflicts ([e0b0ee4](https://github.com/wyattjoh/stacked-prs/commit/e0b0ee46d0bd8e8fdce8649611a4ed12ac2dd539))
* **restack:** detect deleted branches in config and resume-state ([b8f85e7](https://github.com/wyattjoh/stacked-prs/commit/b8f85e769d511ef2dca65b917f354d302d3d8d9d))
* **restack:** execute per-branch rebase, drop middle-branch drift bug ([e0556c4](https://github.com/wyattjoh/stacked-prs/commit/e0556c48e67f5a0cfa7443f70647f78de08ac7b5))
* **restack:** persist resume state across process invocations ([98b8d40](https://github.com/wyattjoh/stacked-prs/commit/98b8d40f7205931e7122b8da3b4818bbee646455))
* **restack:** preserve merge commits via git rebase --rebase-merges ([dcd8adf](https://github.com/wyattjoh/stacked-prs/commit/dcd8adf43616d755485cba62dfba40ffc63925da))
* **stack:** add listAllStacks and getAllStackTrees helpers ([c5891ae](https://github.com/wyattjoh/stacked-prs/commit/c5891ae95c9621acc6a503c80e738003a5ad98d0))
* **tui:** add deterministic stack color palette ([b1814d2](https://github.com/wyattjoh/stacked-prs/commit/b1814d21e5147d58b1ed6bb800d8b5084dba2886))
* **tui:** add HeaderBox component showing only active view ([2bcc2fb](https://github.com/wyattjoh/stacked-prs/commit/2bcc2fb6f4f95dad6f1b1ff7a36ddc788d6b0230))
* **tui:** add land state slice and action handlers ([94727b4](https://github.com/wyattjoh/stacked-prs/commit/94727b4fc27d0384cfce24f05a3f97ed0c4d3ae1))
* **tui:** add LandModal with planning/confirming/executing/done/error phases ([44d47e4](https://github.com/wyattjoh/stacked-prs/commit/44d47e47e9343b414049ee69ea6f06026aa32d20))
* **tui:** add shared type definitions ([78d9a33](https://github.com/wyattjoh/stacked-prs/commit/78d9a33b3dcbdf4548c0a39f9f4590240270f055))
* **tui:** App root component with reducer, loader, and input handling ([7a0792c](https://github.com/wyattjoh/stacked-prs/commit/7a0792c1f9f40dd3b4b62ea908535982b023e641))
* **tui:** build 2D grid layout from stack trees ([a742b4f](https://github.com/wyattjoh/stacked-prs/commit/a742b4f63c9c9a50a36c05469b340e623f42e5b2))
* **tui:** color PR info line by state ([5946dab](https://github.com/wyattjoh/stacked-prs/commit/5946dab1f3a72f746b7d12f45c77ba7f5af6c496))
* **tui:** cross-platform clipboard copy shim ([3fbcc0a](https://github.com/wyattjoh/stacked-prs/commit/3fbcc0a4127b66d8537337f3a290a48442ca7504))
* **tui:** derive primary focus color from theme ([e2e4199](https://github.com/wyattjoh/stacked-prs/commit/e2e419960e7b6bbad753bbc43f0e5d1b9086a624))
* **tui:** DetailPane component ([43612d3](https://github.com/wyattjoh/stacked-prs/commit/43612d3eccdbf270c0ef99b322c736e34ffb5827))
* **tui:** detect merged PRs via gh pr list --state all ([a37ca69](https://github.com/wyattjoh/stacked-prs/commit/a37ca696cc3ec1c8cc36fb39da3fbcf501720b15))
* **tui:** HelpOverlay component with key bindings table ([2056d0e](https://github.com/wyattjoh/stacked-prs/commit/2056d0e5995d1668ebe3499c9147728452086b04))
* **tui:** join stack bars into main with canopy row ([ea04160](https://github.com/wyattjoh/stacked-prs/commit/ea041607b688b6944296f4db32f90b473bf74ad4))
* **tui:** progressive loader for local and PR data ([feda447](https://github.com/wyattjoh/stacked-prs/commit/feda447f135391d132622b3516643ed85bb33e53))
* **tui:** pure arrow-key navigation with preferred-column rule ([6e3df2f](https://github.com/wyattjoh/stacked-prs/commit/6e3df2f5aeffe6ede26bd8015ac3c422aceac5cc))
* **tui:** pure reducer for TUI state transitions ([e7b0c3d](https://github.com/wyattjoh/stacked-prs/commit/e7b0c3d887bc88356a0a29475cb83a8b38a46533))
* **tui:** replace TabBar with boxed HeaderBox ([2e3795d](https://github.com/wyattjoh/stacked-prs/commit/2e3795d18801afe543d2bf5a43fb2b3350216fdf))
* **tui:** retheme detail pane border to primary focus color ([5fa464f](https://github.com/wyattjoh/stacked-prs/commit/5fa464f0dadfb26c6fe92d4bc688e510ea262a6d))
* **tui:** rewrite status view as a vertical ladder with shared trunk ([2f586d2](https://github.com/wyattjoh/stacked-prs/commit/2f586d2b7a39e3f5a8fe0380e2f02770fec65a60))
* **tui:** show notice when opening PR in browser ([db39b9e](https://github.com/wyattjoh/stacked-prs/commit/db39b9ed8f2372e816abb1288c6b6f56de77c652))
* **tui:** StackBand component with colored connectors ([a51ad3c](https://github.com/wyattjoh/stacked-prs/commit/a51ad3c82c8018a3e3be5d6464722d2240d3ff4b))
* **tui:** StackMap container with tab filtering ([85b9dc5](https://github.com/wyattjoh/stacked-prs/commit/85b9dc5b44a65c69150170e78f65fe810ab9b94e))
* **tui:** TabBar component with loading counter ([c761dc6](https://github.com/wyattjoh/stacked-prs/commit/c761dc6c1aae3a7bceb892ed7708e18cf5111e2d))
* **tui:** two-line Node component ([ea7deca](https://github.com/wyattjoh/stacked-prs/commit/ea7deca93b24dce4a4d1a830fa6ed0d4cf7290a2))
* **tui:** wire L key, land modal, and planning+execution effects ([b269606](https://github.com/wyattjoh/stacked-prs/commit/b2696067044e60b5574bb576749eb5641f297bb8))
* **tui:** wrap stack map body in bordered box with focus color ([dcb8f54](https://github.com/wyattjoh/stacked-prs/commit/dcb8f54ddaccc9e0c3a796f0a4d7bed580b7b816))
* **worktrees:** detect branch collisions in linked worktrees ([76d8f9b](https://github.com/wyattjoh/stacked-prs/commit/76d8f9bfe8e56e2719fe0b7da18dd9bb12965400))
* **worktrees:** detect in-progress git operations ([bce8ec3](https://github.com/wyattjoh/stacked-prs/commit/bce8ec340b26795d632b7a6634fbc19e6ab638d6))


### Bug Fixes

* **land:** address pre-release correctness issues and simplify code ([6aa2f9c](https://github.com/wyattjoh/stacked-prs/commit/6aa2f9c3e220419e7d982c3c76b1c5dcd6ce7173))
* **land:** fall back to base branch when original HEAD branch was deleted ([58ea7b4](https://github.com/wyattjoh/stacked-prs/commit/58ea7b4c78a1800897f33d335fb5447b313ec933))
* **restack:** address Codex review findings ([f50b350](https://github.com/wyattjoh/stacked-prs/commit/f50b350a064817b680c19237c136ca9e2ec8acbd))
* **restack:** stop walk at first conflict, defer siblings to resume ([f072e5d](https://github.com/wyattjoh/stacked-prs/commit/f072e5d4aed457d645cb0f419d84e9899c19604d))
* **tui:** align connector NODE_WIDTH with Node component ([f288e73](https://github.com/wyattjoh/stacked-prs/commit/f288e738cfb57e6398d70ee173f103408b22ff8e))
* **tui:** fill terminal, stop truncating names, scroll horizontally ([ff3f93f](https://github.com/wyattjoh/stacked-prs/commit/ff3f93f0745d10860d8fe3484e95eee349b67230))
* **tui:** force isTTY for Ink rendering and shrink empty detail pane ([3cf747b](https://github.com/wyattjoh/stacked-prs/commit/3cf747bf0844e1c0460977a475d679cd4ae87eea))
* **tui:** keep cursor branch fully visible in narrow terminals ([2469805](https://github.com/wyattjoh/stacked-prs/commit/246980505f1b3c53051813a0eb0207a3ab2ae03d))
* **tui:** match header border brightness to body wrapper ([a0b4182](https://github.com/wyattjoh/stacked-prs/commit/a0b418278724e327045c89f0c92cdd9d1c16f4c5))
* **tui:** scope cursor to active stack tab ([aeb5878](https://github.com/wyattjoh/stacked-prs/commit/aeb5878432479332d5d6a678f65264f319f94fb9))
* **tui:** stop frame stacking by clipping overflow and fixing terminal size ([f9defcc](https://github.com/wyattjoh/stacked-prs/commit/f9defcc197af8f9e08d39835a7b1410a363425ec))
* **tui:** suppress process.kill prompt on signal exit ([bb5109a](https://github.com/wyattjoh/stacked-prs/commit/bb5109afef8bdce2cc6893901483a418b6245562))
* **tui:** truncate node names to fixed width and fix header label ([f530854](https://github.com/wyattjoh/stacked-prs/commit/f5308541c620fbf803b27e12e7b92f6bdd9478ed))
* **tui:** un-mute header text when section is focused ([44aa9a5](https://github.com/wyattjoh/stacked-prs/commit/44aa9a5c794f252bac2d763f5efca1bdff3c5f59))
* **worktrees:** parse porcelain -z to handle renames and leading spaces ([f4491f5](https://github.com/wyattjoh/stacked-prs/commit/f4491f5034736b72ca15db57e83215241b429fac))
