# Installing the emulator (before the first use; usually the owner or whoever runs the machine does it)
Summary: Setting up the Android emulator before the phone is used for the first time: install the Android SDK, download a system image and create a phone, tell HH in the config which one to use, the first boot and the logins.
When to open: When `phone-start` says no emulator is configured yet, or a phone is to be created or rebuilt.

1. **Install the Android SDK**: install Android Studio, or only the command-line tools; the SDK is in `~/Library/Android/sdk` by default (elsewhere, set the environment variable `ANDROID_HOME`). Two things are needed, `platform-tools` (which holds `adb`) and `emulator`: `sdkmanager "platform-tools" "emulator"`.
2. **Download a system image and create a phone**: a Mac with an Apple chip uses an arm64 image.
   - `sdkmanager "system-images;android-34;google_apis;arm64-v8a"`
   - `avdmanager create avd -n <name> -k "system-images;android-34;google_apis;arm64-v8a" -d pixel_6`
   - When `emulator -list-avds` shows this name, it is created. Image and data come to a dozen GB or more for one phone; when the system disk is short, move `~/.android/avd/<name>.avd` to an external disk and leave a link in its place.
3. **Tell HH which one to use**: in the instance config write `"modules": { "phone": { "enabled": true, "avd": "<name>" } }`; to change the port, the memory (MB) or to run without a window, add `port`, `memoryMb`, `"window": false`. It is right when `hh modules check phone` shows "ok".
4. **The first boot**: `phone-start`. Once it is up, log in to the apps to be used inside the emulator (scanning codes and SMS verification codes are done by a person); turning off preinstalled apps that are not used saves a good deal of memory.
5. **To watch it on the computer**: the emulator opens a window by default; or install `scrcpy` to mirror its screen.
