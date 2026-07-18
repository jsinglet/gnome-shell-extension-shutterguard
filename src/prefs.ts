import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

interface CameraInfo {
    model: string;
    port: string;
}

interface HelperResolution {
    path: string | null;
    development: boolean;
}

function resolveHelperPath(extensionPath: string): HelperResolution {
    const markerPath = GLib.build_filenamev([extensionPath, '.dev-helper-path']);
    if (GLib.file_test(markerPath, GLib.FileTest.EXISTS)) {
        try {
            const [, contents] = Gio.File.new_for_path(markerPath).load_contents(null);
            const path = new TextDecoder().decode(contents).trim();
            if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
                return {path, development: true};
        } catch {
            // Fall through to the production helper. A stale development
            // marker must never hide an installed RPM.
        }
    }
    const installed = '/usr/libexec/shutterguard/shutterguard-helper';
    if (GLib.file_test(installed, GLib.FileTest.IS_EXECUTABLE))
        return {path: installed, development: false};
    return {path: GLib.find_program_in_path('shutterguard-helper'), development: false};
}

function parseCameraList(output: string): CameraInfo[] {
    const cameras = new Map<string, CameraInfo>();
    for (const line of output.split('\n')) {
        const [kind, port, model] = line.trim().split('\t');
        if (kind === 'CAMERA' && port && model)
            cameras.set(port, {port, model});
    }
    return [...cameras.values()];
}

export default class ShutterGuardPreferences extends ExtensionPreferences {
    private _cameras: CameraInfo[] = [];
    private _cameraRow: Adw.ComboRow | null = null;
    private _scanButton: Gtk.Button | null = null;
    private _scanProcess: Gio.Subprocess | null = null;
    private _updatingCamera = false;
    private _helperPathValue: string | null = null;

    async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();
        const helper = resolveHelperPath(this.path);
        this._helperPathValue = helper.path;
        window.set_default_size(620, 620);
        window.search_enabled = true;

        const page = new Adw.PreferencesPage({
            title: 'ShutterGuard',
            icon_name: 'camera-photo-symbolic',
        });

        const installation = new Adw.PreferencesGroup({
            title: 'Native helper installation',
            description: 'The GNOME extension and native camera helper are installed separately.',
        });
        const installRow = new Adw.ActionRow({
            title: helper.path
                ? `Helper detected${helper.development ? ' · Development mode' : ''}`
                : helper.development ? 'Development helper missing' : 'Helper RPM not installed',
            subtitle: helper.path
                ? helper.path
                : helper.development
                    ? 'Run make install-dev from the ShutterGuard source tree.'
                    : 'Run: sudo dnf copr enable johnlsingleton/shutterguard && sudo dnf install shutterguard-helper',
            icon_name: helper.path ? 'emblem-ok-symbolic' : 'dialog-warning-symbolic',
        });
        installation.add(installRow);
        page.add(installation);

        const protection = new Adw.PreferencesGroup({
            title: 'Live View protection',
            description: 'Keep the selected Canon camera awake over its USB control connection.',
        });
        const active = new Adw.SwitchRow({
            title: 'Protect Live View',
            subtitle: 'Open Live View when enabled and close it when disabled',
            icon_name: 'camera-photo-symbolic',
        });
        active.sensitive = helper.path !== null;
        settings.bind('active', active, 'active', Gio.SettingsBindFlags.DEFAULT);
        protection.add(active);
        page.add(protection);

        const cameraGroup = new Adw.PreferencesGroup({
            title: 'Camera',
            description: 'Cameras detected on the USB bus by libgphoto2.',
        });
        this._cameraRow = new Adw.ComboRow({
            title: 'Selected camera',
            subtitle: 'Scanning USB devices…',
            icon_name: 'camera-web-symbolic',
        });
        this._scanButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Scan for cameras',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._scanButton.sensitive = helper.path !== null;
        this._scanButton.connect('clicked', () => this._refreshCameras(settings));
        this._cameraRow.add_suffix(this._scanButton);
        this._cameraRow.connect('notify::selected', () => {
            if (this._updatingCamera || !this._cameraRow) return;
            const camera = this._cameras[this._cameraRow.selected];
            if (!camera) return;
            settings.set_string('camera-model', camera.model);
            settings.set_string('camera-port', camera.port);
            this._cameraRow.subtitle = camera.port;
            }
        );
        cameraGroup.add(this._cameraRow);
        page.add(cameraGroup);

        const timing = new Adw.PreferencesGroup({
            title: 'Timing',
            description: 'Shorter intervals create more USB activity. Sixty seconds is a good starting point.',
        });
        const frequency = new Adw.SpinRow({
            title: 'Keepalive interval',
            subtitle: 'Seconds between camera keepalive operations',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 300,
                step_increment: 5,
                page_increment: 30,
                value: settings.get_int('frequency'),
            }),
            numeric: true,
        });
        frequency.connect('notify::value', () => {
            const value = Math.round(frequency.value);
                if (settings.get_int('frequency') !== value)
                    settings.set_int('frequency', value);
            }
        );
        const frequencyChangedId = settings.connect('changed::frequency', () => {
            const value = settings.get_int('frequency');
                if (Math.round(frequency.value) !== value)
                    frequency.value = value;
            }
        );
        timing.add(frequency);
        page.add(timing);

        const about = new Adw.PreferencesGroup({title: 'About'});
        about.add(new Adw.ActionRow({
            title: 'ShutterGuard',
            subtitle: `Native Canon EOS keepalive for GNOME · Version ${this.metadata['version-name'] ?? this.metadata.version}`,
            icon_name: 'dialog-information-symbolic',
        }));
        page.add(about);

        window.add(page);
        window.connect('close-request', () => {
                this._scanProcess?.force_exit();
                this._scanProcess = null;
                this._cameras = [];
                this._cameraRow = null;
                this._scanButton = null;
                this._updatingCamera = false;
                this._helperPathValue = null;
                settings.disconnect(frequencyChangedId);
                return false;
            }
        );
        if (this._helperPathValue)
            this._refreshCameras(settings);
        else {
            this._cameraRow.subtitle = 'Install shutterguard-helper to scan USB cameras';
            this._cameraRow.sensitive = false;
        }
    }

    private _refreshCameras(settings: Gio.Settings): void {
        if (!this._cameraRow || !this._scanButton || !this._helperPathValue) return;
        this._cameraRow.subtitle = 'Scanning USB devices…';
        this._scanButton.sensitive = false;
        try {
            this._scanProcess?.force_exit();
            this._scanProcess = Gio.Subprocess.new(
                [this._helperPathValue, '--list-cameras'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            const process = this._scanProcess;
            process.communicate_utf8_async(null, null, (_source, result) => {
                try {
                    const [ok, stdout, stderr] = process.communicate_utf8_finish(result);
                    if (this._scanProcess !== process) return;
                    this._scanProcess = null;
                    if (!ok) throw new Error(stderr || 'Camera scan failed');
                    this._showCameras(settings, parseCameraList(stdout || ''));
                } catch (e) {
                    if (this._scanProcess !== process) return;
                    this._scanProcess = null;
                    console.error(`[ShutterGuard Preferences] camera scan failed: ${e}`);
                    this._showCameras(settings, []);
                }
            });
        } catch (e) {
            console.error(`[ShutterGuard Preferences] could not start camera scan: ${e}`);
            this._scanProcess = null;
            this._showCameras(settings, []);
        }
    }

    private _showCameras(settings: Gio.Settings, cameras: CameraInfo[]): void {
        if (!this._cameraRow || !this._scanButton) return;
        this._cameras = cameras;
        const model = new Gtk.StringList();
        if (cameras.length === 0)
            model.append('No cameras detected');
        else
            cameras.forEach(camera => model.append(camera.model));

        this._updatingCamera = true;
        this._cameraRow.model = model;
        const selectedPort = settings.get_string('camera-port');
        let selected = cameras.findIndex(camera => camera.port === selectedPort);
        if (selected < 0 && cameras.length > 0) {
            selected = 0;
            settings.set_string('camera-model', cameras[0].model);
            settings.set_string('camera-port', cameras[0].port);
        }
        this._cameraRow.selected = Math.max(0, selected);
        this._cameraRow.subtitle = cameras.length === 0
            ? 'Connect a camera by USB and scan again'
            : cameras[Math.max(0, selected)].port;
        this._cameraRow.sensitive = true;
        this._scanButton.sensitive = true;
        this._updatingCamera = false;
    }
}
