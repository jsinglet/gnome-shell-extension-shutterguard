import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const MIN_FREQUENCY = 10;
const MAX_FREQUENCY = 300;
const FREQUENCY_STEP = 5;

interface CameraInfo {
    model: string;
    port: string;
}

interface HelperResolution {
    path: string | null;
    development: boolean;
}

function resolveInstalledHelperPath(): HelperResolution {
    const installed = '/usr/libexec/shutterguard/shutterguard-helper';
    if (GLib.file_test(installed, GLib.FileTest.IS_EXECUTABLE))
        return {path: installed, development: false};
    return {path: GLib.find_program_in_path('shutterguard-helper'), development: false};
}

function loadDevelopmentHelperPath(
    extensionPath: string,
    callback: (path: string | null) => void,
): void {
    const marker = Gio.File.new_for_path(
        GLib.build_filenamev([extensionPath, '.dev-helper-path']));
    marker.load_contents_async(null, (file, result) => {
        try {
            const [, contents] = file!.load_contents_finish(result);
            const path = new TextDecoder().decode(contents).trim();
            callback(GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) ? path : null);
        } catch {
            // A missing marker is the normal production configuration.
            callback(null);
        }
    });
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

class ShutterGuardIndicatorBase extends PanelMenu.Button {
    declare private _settings: Gio.Settings;
    declare private _extensionPath: string;
    declare private _openPreferences: () => void;
    declare private _process: Gio.Subprocess | null;
    declare private _scanProcess: Gio.Subprocess | null;
    declare private _starting: boolean;
    declare private _restartPending: boolean;
    declare private _helperPathValue: string | null;
    declare private _developmentMode: boolean;
    declare private _panelIcon: St.Icon;
    declare private _statusLabel: St.Label;
    declare private _activeItem: PopupMenu.PopupSwitchMenuItem;
    declare private _helperWarning: PopupMenu.PopupBaseMenuItem;
    declare private _blockerWarning: PopupMenu.PopupBaseMenuItem;
    declare private _blockerTitle: St.Label;
    declare private _blockerDetail: St.Label;
    declare private _releaseBlockerItem: PopupMenu.PopupImageMenuItem;
    declare private _blockerPid: number;
    declare private _blockerProcess: string;
    declare private _cameraMenu: PopupMenu.PopupSubMenuMenuItem;
    declare private _refreshItem: PopupMenu.PopupImageMenuItem;
    declare private _preferencesItem: PopupMenu.PopupImageMenuItem;
    declare private _frequencyLabel: St.Label;
    declare private _slider: Slider;
    declare private _syncingFrequency: boolean;
    declare private _frequencyCommitSource: number;
    declare private _restartSource: number;
    declare private _retrySource: number;
    declare private _mountDelaySource: number;
    declare private _scanGeneration: number;
    declare private _destroyed: boolean;

    override _init(...args: unknown[]): void {
        const [settings, extensionPath, openPreferences] = args as [
            Gio.Settings, string, () => void,
        ];
        super._init(0.0, 'ShutterGuard', false);
        this._settings = settings;
        this._extensionPath = extensionPath;
        this._openPreferences = openPreferences;
        this._process = null;
        this._scanProcess = null;
        this._starting = false;
        this._restartPending = false;
        this._syncingFrequency = false;
        this._frequencyCommitSource = 0;
        this._restartSource = 0;
        this._retrySource = 0;
        this._mountDelaySource = 0;
        this._scanGeneration = 0;
        this._destroyed = false;
        this._blockerPid = 0;
        this._blockerProcess = '';
        const helper = resolveInstalledHelperPath();
        this._helperPathValue = helper.path;
        this._developmentMode = helper.development;
        this.accessible_name = 'ShutterGuard camera protection';

        this._panelIcon = new St.Icon({
            icon_name: 'camera-photo-symbolic',
            style_class: 'system-status-icon shutterguard-panel-icon',
        });
        this.add_child(this._panelIcon);
        const menu = this.menu as PopupMenu.PopupMenu;

        const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const header = new St.BoxLayout({style_class: 'shutterguard-header', x_expand: true});
        const emblem = new St.Icon({
            icon_name: 'camera-photo-symbolic',
            style_class: 'shutterguard-header-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const headerText = new St.BoxLayout({vertical: true, x_expand: true});
        headerText.add_child(new St.Label({text: 'ShutterGuard', style_class: 'shutterguard-title'}));
        this._statusLabel = new St.Label({text: 'Protection is off', style_class: 'shutterguard-status'});
        headerText.add_child(this._statusLabel);
        header.add_child(emblem);
        header.add_child(headerText);
        headerItem.add_child(header);
        menu.addMenuItem(headerItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._helperWarning = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const warningBox = new St.BoxLayout({
            style_class: 'shutterguard-helper-warning',
            x_expand: true,
        });
        warningBox.add_child(new St.Icon({
            icon_name: 'dialog-warning-symbolic',
            style_class: 'shutterguard-warning-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const warningText = new St.BoxLayout({vertical: true, x_expand: true});
        warningText.add_child(new St.Label({
            text: this._developmentMode ? 'Development helper missing' : 'Native helper RPM required',
            style_class: 'shutterguard-warning-title',
        }));
        warningText.add_child(new St.Label({
            text: this._developmentMode
                ? 'Run make install-dev from the source tree'
                : 'Enable COPR johnlsingleton/shutterguard, then install shutterguard-helper',
            style_class: 'shutterguard-warning-detail',
        }));
        warningBox.add_child(warningText);
        this._helperWarning.add_child(warningBox);
        this._helperWarning.visible = this._helperPathValue === null;
        menu.addMenuItem(this._helperWarning);

        this._blockerWarning = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const blockerBox = new St.BoxLayout({
            style_class: 'shutterguard-helper-warning',
            x_expand: true,
        });
        blockerBox.add_child(new St.Icon({
            icon_name: 'action-unavailable-symbolic',
            style_class: 'shutterguard-warning-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const blockerText = new St.BoxLayout({vertical: true, x_expand: true});
        this._blockerTitle = new St.Label({style_class: 'shutterguard-warning-title'});
        this._blockerDetail = new St.Label({style_class: 'shutterguard-warning-detail'});
        blockerText.add_child(this._blockerTitle);
        blockerText.add_child(this._blockerDetail);
        blockerBox.add_child(blockerText);
        this._blockerWarning.add_child(blockerBox);
        this._blockerWarning.visible = false;
        menu.addMenuItem(this._blockerWarning);

        this._releaseBlockerItem = new PopupMenu.PopupImageMenuItem(
            'Release camera and retry', 'media-eject-symbolic');
        this._releaseBlockerItem.visible = false;

        
        this._releaseBlockerItem.connectObject(
            'activate', () => this._requestBlockerRelease(),
            this
        );

        menu.addMenuItem(this._releaseBlockerItem);

        this._activeItem = new PopupMenu.PopupSwitchMenuItem(
            'Protect Live View', settings.get_boolean('active'));
        
        
        this._activeItem.connectObject('toggled',
            (_item: PopupMenu.PopupSwitchMenuItem, state: boolean) => {
                // Re-resolve here as well as on menu open so an RPM installed after
                // Shell startup is usable without reloading the whole session.
                if (state && !this._refreshHelperResolution()) {
                    this._activeItem.setToggleState(false);
                    this._showHelperMissing();
                    return;
                }
                settings.set_boolean('active', state);
            },
            this
        );
        
        menu.addMenuItem(this._activeItem);

        this._cameraMenu = new PopupMenu.PopupSubMenuMenuItem('Scanning for cameras…', true);
        if (this._cameraMenu.icon)
            this._cameraMenu.icon.icon_name = 'camera-photo-symbolic';
        menu.addMenuItem(this._cameraMenu);

        const frequencyItem = new PopupMenu.PopupBaseMenuItem({activate: false});
        frequencyItem.accessible_name = 'Keepalive frequency';
        const frequencyBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'shutterguard-frequency-box',
        });
        const frequencyHeader = new St.BoxLayout({x_expand: true});
        frequencyHeader.add_child(new St.Label({
            text: 'Keepalive interval',
            x_expand: true,
            style_class: 'shutterguard-control-label',
        }));
        this._frequencyLabel = new St.Label({style_class: 'shutterguard-value-label'});
        frequencyHeader.add_child(this._frequencyLabel);
        frequencyBox.add_child(frequencyHeader);
        this._slider = new Slider(0);
        this._slider.accessible_name = 'Seconds between camera keepalive operations';
        this._slider.x_expand = true;
        frequencyBox.add_child(this._slider);
        frequencyItem.add_child(frequencyBox);
        menu.addMenuItem(frequencyItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._refreshItem = new PopupMenu.PopupImageMenuItem('Scan for cameras', 'view-refresh-symbolic');
        this._refreshItem.sensitive = this._helperPathValue !== null;
        
        this._refreshItem.connectObject(
            'activate', 
            () => this._refreshCameras(),
            this
        );
        
        menu.addMenuItem(this._refreshItem);
        this._preferencesItem = new PopupMenu.PopupImageMenuItem(
            'ShutterGuard Settings', 'emblem-system-symbolic');
        
        this._preferencesItem.connectObject(
            'activate',
            () => this._openPreferences(),
            this
        );
            
        menu.addMenuItem(this._preferencesItem);

        this._slider.connectObject(
            'notify::value',
            () => this._onSliderChanged(),
            this
        );
        
        settings.connectObject(
            'changed::frequency', () => this._syncFrequency(),
            'changed::active', () => this._syncActive(),
            'changed::camera-port', () => this._syncCameraSelection(),
            this
        );
        
        menu.connectObject(
            'open-state-changed',
            (_menu : PopupMenu.PopupMenu, isOpen : boolean) => {
                if (isOpen && this._refreshHelperResolution()) this._refreshCameras();
            },   
            this
        );

        this._cameraMenu.sensitive = this._helperPathValue !== null;
        this._syncFrequency();
        this._syncActive();
        if (this._helperPathValue) {
            this._log(`helper resolved path=${this._helperPathValue} mode=${this._developmentMode ? 'development' : 'production'}`);
            this._refreshCameras();
        } else {
            this._showHelperMissing();
            this._log(`helper unavailable mode=${this._developmentMode ? 'development' : 'production'}`);
        }
        this._loadDevelopmentHelper();
    }

    private _log(message: string): void {
        if (this._developmentMode)
            console.log(`[ShutterGuard] ${message}`);
    }

    private _setStatus(message: string, state: 'idle' | 'active' | 'warning' = 'idle'): void {
        this._statusLabel.text = message;
        this._panelIcon.remove_style_class_name('shutterguard-active');
        this._panelIcon.remove_style_class_name('shutterguard-warning');
        if (state === 'active') this._panelIcon.add_style_class_name('shutterguard-active');
        if (state === 'warning') this._panelIcon.add_style_class_name('shutterguard-warning');
    }

    private _refreshHelperResolution(): boolean {
        const previousPath = this._helperPathValue;
        const helper = this._developmentMode && previousPath &&
            GLib.file_test(previousPath, GLib.FileTest.IS_EXECUTABLE)
            ? {path: previousPath, development: true}
            : resolveInstalledHelperPath();
        this._helperPathValue = helper.path;
        this._developmentMode = helper.development;
        const available = helper.path !== null;
        this._helperWarning.visible = !available;
        this._cameraMenu.sensitive = available;
        this._refreshItem.sensitive = available;

        if (helper.path && helper.path !== previousPath)
            this._log(`helper resolved path=${helper.path} mode=${helper.development ? 'development' : 'production'}`);
        else if (!helper.path && previousPath)
            this._log('previously resolved helper is no longer available');

        return available;
    }

    private _loadDevelopmentHelper(): void {
        loadDevelopmentHelperPath(this._extensionPath, path => {
            if (this._destroyed || !path) return;
            const changed = path !== this._helperPathValue || !this._developmentMode;
            this._helperPathValue = path;
            this._developmentMode = true;
            this._helperWarning.visible = false;
            this._cameraMenu.sensitive = true;
            this._refreshItem.sensitive = true;
            if (!changed) return;
            this._log(`helper resolved path=${path} mode=development`);
            if (this._settings.get_boolean('active'))
                this._scheduleRestart();
            else
                this._refreshCameras();
        });
    }

    private _secondsFromSlider(): number {
        const raw = MIN_FREQUENCY + this._slider.value * (MAX_FREQUENCY - MIN_FREQUENCY);
        return Math.max(MIN_FREQUENCY, Math.min(MAX_FREQUENCY,
            Math.round(raw / FREQUENCY_STEP) * FREQUENCY_STEP));
    }

    private _onSliderChanged(): void {
        if (this._syncingFrequency) return;
        const seconds = this._secondsFromSlider();
        this._frequencyLabel.text = `${seconds} s`;
        if (this._frequencyCommitSource) GLib.source_remove(this._frequencyCommitSource);
        this._frequencyCommitSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 180, () => {
            this._frequencyCommitSource = 0;
            if (this._settings.get_int('frequency') !== seconds) {
                this._log(`frequency changed to ${seconds}s`);
                this._settings.set_int('frequency', seconds);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    private _syncFrequency(): void {
        const seconds = this._settings.get_int('frequency');
        this._frequencyLabel.text = `${seconds} s`;
        this._syncingFrequency = true;
        this._slider.value = (seconds - MIN_FREQUENCY) / (MAX_FREQUENCY - MIN_FREQUENCY);
        this._syncingFrequency = false;
        if (this._process) this._scheduleRestart();
    }

    private _syncActive(): void {
        const active = this._settings.get_boolean('active');
        if (active && !this._helperPathValue) {
            this._activeItem.setToggleState(false);
            this._settings.set_boolean('active', false);
            this._setStatus('Native helper is not installed', 'warning');
            return;
        }
        this._activeItem.setToggleState(active);
        if (active) {
            this._setStatus('Starting camera protection…', 'warning');
            if (this._process) {
                // A previous helper may still be unwinding a blocking PTP
                // call after SIGTERM. Never overlap camera-control sessions.
                this._restartPending = true;
                this._setStatus('Waiting for camera service to stop…', 'warning');
            } else {
                this._start();
            }
        } else {
            this._stop();
            this._clearDeviceBlocker();
            this._setStatus('Protection is off');
        }
    }

    private _syncCameraSelection(): void {
        if (this._process) this._scheduleRestart();
    }

    private _showHelperMissing(): void {
        this._cameraMenu.label.text = 'Camera service unavailable';
        this._cameraMenu.menu.removeAll();
        this._cameraMenu.menu.addMenuItem(new PopupMenu.PopupMenuItem(
            'Install shutterguard-helper from COPR johnlsingleton/shutterguard to scan cameras',
            {reactive: false}));
        this._setStatus(this._developmentMode
            ? 'Development helper is missing'
            : 'Native helper RPM is not installed', 'warning');
    }

    private _helperField(line: string, name: string): string | null {
        const match = line.match(new RegExp(`(?:^|\\s)${name}=([^\\s]+)`));
        return match?.[1] ?? null;
    }

    private _showDeviceBlocker(line: string): void {
        const process = this._helperField(line, 'process') ?? 'unknown';
        const pid = Number.parseInt(this._helperField(line, 'pid') ?? '0', 10);
        this._blockerProcess = process;
        this._blockerPid = Number.isFinite(pid) && pid > 1 ? pid : 0;
        if (process === 'unknown' || !Number.isFinite(pid) || pid <= 0) {
            this._blockerTitle.text = 'Another application owns the camera';
            this._blockerDetail.text = 'Close camera/import apps, then toggle protection off and on';
            this._setStatus('Camera is in use by another application', 'warning');
        } else if (process === 'gvfsd-gphoto2') {
            this._blockerTitle.text = `GNOME Files owns the camera · PID ${pid}`;
            this._blockerDetail.text = `Unmount it in Files, or run: kill ${pid}`;
            this._setStatus('Camera is mounted by GNOME Files', 'warning');
        } else {
            this._blockerTitle.text = `${process} owns the camera · PID ${pid}`;
            this._blockerDetail.text = `Close ${process}, or run: kill ${pid}`;
            this._setStatus(`Camera is in use by ${process}`, 'warning');
        }
        this._blockerWarning.visible = true;
        this._releaseBlockerItem.label.text = process === 'gvfsd-gphoto2'
            ? 'Release camera from GNOME Files'
            : `Ask ${process} to close and retry`;
        this._releaseBlockerItem.visible = this._blockerPid > 1;
        this._releaseBlockerItem.sensitive = this._blockerPid > 1;
    }

    private _clearDeviceBlocker(): void {
        this._blockerWarning.visible = false;
        this._releaseBlockerItem.visible = false;
        this._releaseBlockerItem.sensitive = true;
        this._blockerPid = 0;
        this._blockerProcess = '';
    }

    private _showConnectionFailure(line: string): void {
        const code = Number.parseInt(this._helperField(line, 'code') ?? '0', 10);
        if (code !== -7 && code !== -10) {
            this._setStatus('Camera unavailable · retrying', 'warning');
            return;
        }

        const recentlyMountedByFiles = this._blockerProcess === 'gvfsd-gphoto2';
        this._blockerPid = 0;
        this._blockerProcess = '';
        this._blockerTitle.text = recentlyMountedByFiles
            ? 'GNOME Files released the camera, but it is not responding'
            : 'The camera is not responding over USB';
        this._blockerDetail.text =
            'Turn the camera off, disconnect USB for 5 seconds, then reconnect and power on';
        this._blockerWarning.visible = true;
        this._releaseBlockerItem.visible = false;
        this._releaseBlockerItem.sensitive = true;
        this._setStatus('Camera needs a USB power cycle', 'warning');
    }

    private _requestBlockerRelease(): void {
        if (this._blockerPid <= 1) return;
        if (this._blockerProcess === 'gvfsd-gphoto2') {
            this._releaseDeviceBlocker();
            return;
        }

        const process = this._blockerProcess;
        const dialog = new ModalDialog.ModalDialog();
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: `Ask ${process} to close?`,
            description: `ShutterGuard will send SIGTERM to ${process} (PID ${this._blockerPid}). ` +
                'This may close the application, so save any work first.',
        }));
        dialog.setButtons([
            {
                label: 'Cancel',
                action: () => dialog.close(),
                key: Clutter.KEY_Escape,
            },
            {
                label: 'Close Application and Retry',
                default: true,
                action: () => {
                    dialog.close();
                    this._releaseDeviceBlocker();
                },
            },
        ]);
        dialog.open();
    }

    private _releaseDeviceBlocker(): void {
        if (!this._helperPathValue || this._blockerPid <= 1) return;
        const pid = this._blockerPid;
        const processName = this._blockerProcess;
        const port = this._settings.get_string('camera-port');
        this._releaseBlockerItem.sensitive = false;
        this._blockerDetail.text = `Asking ${processName} to release the camera…`;
        try {
            const process = Gio.Subprocess.new([
                this._helperPathValue,
                '--release-blocker', pid.toString(),
                '--camera-port', port,
            ], Gio.SubprocessFlags.STDERR_PIPE);
            process.communicate_utf8_async(null, null, (_source, result) => {
                try {
                    const [ok, , stderr] = process.communicate_utf8_finish(result);
                    if (this._destroyed) return;
                    if (!ok) throw new Error(stderr || 'release request failed');
                    this._blockerDetail.text = `${processName} was asked to close · retrying`;
                    this._releaseBlockerItem.visible = false;
                    this._setStatus('Camera released · retrying', 'warning');
                    this._scheduleRestart();
                } catch (e) {
                    this._blockerDetail.text = `Could not close ${processName}; run: kill ${pid}`;
                    this._releaseBlockerItem.sensitive = true;
                    this._log(`blocker release failed: ${e}`);
                }
            });
        } catch (e) {
            this._blockerDetail.text = `Could not close ${processName}; run: kill ${pid}`;
            this._releaseBlockerItem.sensitive = true;
            this._log(`could not start blocker release: ${e}`);
        }
    }

    private _refreshCameras(): void {
        if (!this._helperPathValue) {
            this._showHelperMissing();
            return;
        }
        const generation = ++this._scanGeneration;
        this._cameraMenu.label.text = 'Scanning for cameras…';
        this._cameraMenu.menu.removeAll();
        const scanning = new PopupMenu.PopupMenuItem('Scanning USB devices…', {reactive: false});
        this._cameraMenu.menu.addMenuItem(scanning);
        this._log('scanning USB bus for cameras');
        try {
            this._scanProcess?.force_exit();
            this._scanProcess = Gio.Subprocess.new(
                [this._helperPathValue, '--list-cameras'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            const process = this._scanProcess;
            process.communicate_utf8_async(null, null, (_source, result) => {
                try {
                    const [ok, stdout, stderr] = process.communicate_utf8_finish(result);
                    if (generation !== this._scanGeneration) return;
                    this._scanProcess = null;
                    if (!ok) throw new Error(stderr || 'camera scan failed');
                    this._showCameras(parseCameraList(stdout || ''));
                } catch (e) {
                    if (generation !== this._scanGeneration) return;
                    this._scanProcess = null;
                    this._log(`camera scan failed: ${e}`);
                    this._showCameras([], 'Camera scan failed');
                }
            });
        } catch (e) {
            this._scanProcess = null;
            this._log(`could not start camera scan: ${e}`);
            this._showCameras([], 'Camera scan unavailable');
        }
    }

    private _showCameras(cameras: CameraInfo[], emptyMessage = 'No cameras detected'): void {
        this._cameraMenu.menu.removeAll();
        const selectedPort = this._settings.get_string('camera-port');
        if (cameras.length === 0) {
            this._cameraMenu.label.text = emptyMessage;
            const none = new PopupMenu.PopupMenuItem(
                'Connect a camera by USB, then scan again', {reactive: false});
            this._cameraMenu.menu.addMenuItem(none);
            this._log('camera scan complete; count=0');
            return;
        }

        let selected = cameras.find(camera => camera.port === selectedPort);
        if (!selected) {
            selected = cameras[0];
            this._settings.set_string('camera-model', selected.model);
            this._settings.set_string('camera-port', selected.port);
        }
        this._cameraMenu.label.text = selected.model;
        for (const camera of cameras) {
            const item = new PopupMenu.PopupMenuItem(`${camera.model}  (${camera.port})`);
            item.setOrnament(camera.port === selected.port
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.connectObject(
                'activate', () => {
                    this._settings.set_string('camera-model', camera.model);
                    this._settings.set_string('camera-port', camera.port);
                    this._cameraMenu.label.text = camera.model;
                    this._log(`selected camera model=\"${camera.model}\" port=${camera.port}`);
                    this._showCameras(cameras);
                    }, 
                this
            );
            this._cameraMenu.menu.addMenuItem(item);
        }
        this._log(`camera scan complete; count=${cameras.length} selected=\"${selected.model}\"`);
    }

    private _start(): void {
        if (!this._helperPathValue) {
            this._showHelperMissing();
            return;
        }
        if (this._process || this._starting) return;
        this._starting = true;
        const mounts = Gio.VolumeMonitor.get().get_mounts().filter(mount =>
            mount.get_root().get_uri().startsWith('gphoto2://'));
        if (mounts.length === 0) {
            this._starting = false;
            this._spawnHelper();
            return;
        }

        this._log(`releasing ${mounts.length} automatic GVfs camera mount(s)`);
        let pending = mounts.length;
        for (const mount of mounts) {
            const uri = mount.get_root().get_uri();
            mount.unmount_with_operation(
                Gio.MountUnmountFlags.NONE, null, null, (_source, result) => {
                    try {
                        mount.unmount_with_operation_finish(result);
                        this._log(`released automatic camera mount ${uri}`);
                    } catch (e) {
                        this._log(`could not release camera mount ${uri}: ${e}`);
                    }
                    if (--pending === 0) {
                        this._starting = false;
                        this._mountDelaySource = GLib.timeout_add(
                            GLib.PRIORITY_DEFAULT, 250, () => {
                            this._mountDelaySource = 0;
                            if (this._settings.get_boolean('active')) this._spawnHelper();
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                });
        }
    }

    private _spawnHelper(): void {
        if (this._process || !this._settings.get_boolean('active') || !this._helperPathValue) return;
        const frequency = this._settings.get_int('frequency').toString();
        const args = [this._helperPathValue, '--frequency', frequency];
        if (this._developmentMode) args.push('--verbose');
        const model = this._settings.get_string('camera-model');
        const port = this._settings.get_string('camera-port');
        if (model && port) args.push('--camera-model', model, '--camera-port', port);
        this._log(`starting helper; frequency=${frequency}s camera=\"${model || 'automatic'}\" port=${port || 'automatic'}`);
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
            });
            this._process = launcher.spawnv(args);
            const stream = new Gio.DataInputStream({base_stream: this._process.get_stdout_pipe()!});
            const readLine = () => stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_source, result) => {
                try {
                    const [line] = stream.read_line_finish_utf8(result);
                    if (this._destroyed) return;
                    if (line !== null) {
                        this._log(`helper: ${line}`);
                        if (line.includes('event=device-blocked'))
                            this._showDeviceBlocker(line);
                        else if (line.includes('event=live-view state=open')) {
                            this._clearDeviceBlocker();
                            this._setStatus('Live View is protected', 'active');
                        } else if (line.includes('event=connect-failed'))
                            this._showConnectionFailure(line);
                        else if (line.includes('event=session-lost'))
                            this._setStatus('Camera unavailable · retrying', 'warning');
                        readLine();
                    }
                } catch (e) { this._log(`log stream ended: ${e}`); }
            });
            readLine();
            const process = this._process;
            process.wait_check_async(null, (_source, result) => {
                try { process.wait_check_finish(result); this._log('helper exited normally'); }
                catch (e) { this._log(`helper exited with error: ${e}`); }
                if (this._process === process) {
                    this._process = null;
                    const restartPending = this._restartPending;
                    this._restartPending = false;
                    if (this._destroyed) return;
                    if (this._settings.get_boolean('active')) {
                        if (restartPending) {
                            this._setStatus('Restarting camera protection…', 'warning');
                            this._start();
                        } else {
                            this._setStatus('Camera service stopped · retrying', 'warning');
                            this._retrySource = GLib.timeout_add_seconds(
                                GLib.PRIORITY_DEFAULT, 3, () => {
                                    this._retrySource = 0;
                                    this._start();
                                    return GLib.SOURCE_REMOVE;
                                });
                        }
                    }
                }
            });
        } catch (e) {
            this._process = null;
            this._setStatus('Unable to start camera service', 'warning');
            this._log(`could not start helper: ${e}`);
        }
    }

    private _stop(): void {
        this._starting = false;
        this._restartPending = false;
        if (this._retrySource) GLib.source_remove(this._retrySource);
        this._retrySource = 0;
        if (!this._process) return;
        this._log('stopping helper; requesting Live View close');
        this._process.send_signal(15);
    }

    private _restartHelperAfterExit(): void {
        if (!this._settings.get_boolean('active') || this._destroyed) return;
        if (!this._process) {
            this._start();
            return;
        }
        if (!this._restartPending) {
            this._restartPending = true;
            this._setStatus('Restarting camera protection…', 'warning');
            this._log('restart requested; waiting for current helper to exit');
            this._process.send_signal(15);
        }
    }

    private _scheduleRestart(): void {
        if (this._restartSource) GLib.source_remove(this._restartSource);
        this._restartSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            this._restartSource = 0;
            this._restartHelperAfterExit();
            return GLib.SOURCE_REMOVE;
        });
    }

    override destroy(): void {
        this._destroyed = true;
        this._scanGeneration++;
        this._scanProcess?.force_exit();
        this._scanProcess = null;
        if (this._frequencyCommitSource)
            GLib.source_remove(this._frequencyCommitSource);
        if (this._restartSource)
            GLib.source_remove(this._restartSource);
        if (this._retrySource)
            GLib.source_remove(this._retrySource);
        if (this._mountDelaySource)
            GLib.source_remove(this._mountDelaySource);
        this._frequencyCommitSource = 0;
        this._restartSource = 0;
        this._retrySource = 0;
        this._mountDelaySource = 0;
        this._stop();
        /** cleanup */
        this._releaseBlockerItem.disconnectObject(this);
        this._activeItem.disconnectObject(this);
        this._refreshItem.disconnectObject(this);
        this._preferencesItem.disconnectObject(this);
        this._slider.disconnectObject(this);
        this._settings.disconnectObject(this);
        this.menu?.disconnectObject(this);
        super.destroy();
    }
}

type ShutterGuardIndicatorConstructor = new (
    settings: Gio.Settings,
    extensionPath: string,
    openPreferences: () => void,
) => ShutterGuardIndicatorBase;

const ShutterGuardIndicator = GObject.registerClass(
    {GTypeName: 'ShutterGuardIndicator'},
    ShutterGuardIndicatorBase,
) as unknown as ShutterGuardIndicatorConstructor;

export default class ShutterGuardExtension extends Extension {
    private _indicator: ShutterGuardIndicatorBase | null = null;

    enable(): void {
        this._indicator = new ShutterGuardIndicator(
            this.getSettings(), this.path, () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable(): void {
        if (this._indicator)
            this._indicator.destroy();
        this._indicator = null;
    }
}
