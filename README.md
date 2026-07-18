# ShutterGuard

ShutterGuard is a GNOME Shell extension that has one feature: it keeps the shutter open for cameras that don't support long shutter open times. This is especially handy when using your camera as a webcam. 

It lives up in your gnome menu bar and can be configured to keep the camera open at various polling intervals. 

There is a piece of software, the Canon WebCam Utility which does this, but a) it's not free and b) it doesn't do it as well as this does. With the Canon Utility when a timeout happens the video feel will go blank while the shutter refreshes. Using this utility the shutter will never close while active. 

NOTE: Because you are directly manipulating your camera, please use at your own risk. Author is not responsible for any potential damage that may result from using this extension. 

## Dependencies

- GNOME Shell 45–50 on Wayland or X11
- An RPM-based distribution with the separate `shutterguard-helper` RPM
- A Canon camera connected by USB with no competing PTP client

## RPM Helper

For the extension to work you have to install the helper RPM which talks to the camera over USB.

Fedora:

```sh
sudo dnf install dnf-plugins-core
sudo dnf copr enable johnlsingleton/shutterguard
sudo dnf install shutterguard-helper
```

RHEL-compatible systems must enable the matching EPEL repository first because
it supplies libgphoto2. For RHEL 10:

```sh
sudo dnf install https://dl.fedoraproject.org/pub/epel/epel-release-latest-10.noarch.rpm
sudo dnf install dnf-plugins-core
sudo dnf copr enable johnlsingleton/shutterguard
sudo dnf install shutterguard-helper
```

Substitute `9` for `10` on RHEL 9. Approve the COPR prompt after verifying it
identifies `johnlsingleton/shutterguard`. DNF installs the helper at
`/usr/libexec/shutterguard/shutterguard-helper`, plus a command-line link at
`/usr/bin/shutterguard-helper`.


## Camera compatibility

Verify compatability with: 

```sh
gphoto2 --auto-detect
gphoto2 --get-config viewfinder
```

Or:

```sh
gphoto2 --get-config eosviewfinder
```

If the gphoto2 utility shows your camera, you are likely able to use this utility. 

# Packaging 

Do an npm install in the root of this directory and then:

The target: 

```sh
make package
```

Will build both the zip and the rpm. 

If you want to develop on this and use the gnome nested shell (recommended) you must install both `mutter-devel` and `libgphoto2-devel`.
