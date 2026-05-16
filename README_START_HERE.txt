SeekDeep Fresh Rebuild V2

This package includes the .env file provided by the user.
Do not share this ZIP publicly because it contains live tokens/API keys.

Important fixes in V2:
- setup_local.ps1 no longer assumes Python 3.12 exists.
- setup_local.ps1 verifies .venv\Scripts\python.exe before using it.
- setup_local.ps1 fails clearly if Python or npm are missing.
- The package root is SeekDeep-DiscordBot for direct extraction into the user profile.
- Existing model cache can be moved/copied from the broken backup folder during install.

Recommended install:
Run INSTALL_SeekDeep_Fresh_Rebuild_V2.ps1 from Downloads.
