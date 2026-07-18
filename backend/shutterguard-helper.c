#include <gphoto2/gphoto2-camera.h>
#include <gphoto2/gphoto2-abilities-list.h>
#include <gphoto2/gphoto2-context.h>
#include <gphoto2/gphoto2-list.h>
#include <gphoto2/gphoto2-port-info-list.h>
#include <gphoto2/gphoto2-port-result.h>
#include <gphoto2/gphoto2-widget.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t running = 1;
static int verbose = 0;
static const char *camera_model = NULL;
static const char *camera_port = NULL;

static void on_signal(int sig) { (void)sig; running = 0; }

static void log_msg(const char *level, const char *fmt, ...) {
    char stamp[32]; time_t now = time(NULL); struct tm tm;
    localtime_r(&now, &tm); strftime(stamp, sizeof stamp, "%Y-%m-%dT%H:%M:%S%z", &tm);
    fprintf(stderr, "%s level=%s ", stamp, level);
    va_list ap; va_start(ap, fmt); vfprintf(stderr, fmt, ap); va_end(ap);
    fputc('\n', stderr); fflush(stderr);
}

static void context_error(GPContext *context, const char *message, void *data) {
    (void)context;
    (void)data;
    log_msg("error", "libgphoto2=%s", message);
}
static void context_status(GPContext *context, const char *message, void *data) {
    (void)context;
    (void)data;
    if (!verbose) return;
    log_msg("debug", "libgphoto2=%s", message);
}

static bool numeric_name(const char *value) {
    if (!value || !*value) return false;
    for (const unsigned char *p = (const unsigned char *)value; *p; p++)
        if (!isdigit(*p)) return false;
    return true;
}

static void sanitize_process_name(char *value) {
    for (unsigned char *p = (unsigned char *)value; *p; p++)
        if (!isalnum(*p) && *p != '.' && *p != '_' && *p != '-') *p = '_';
}

static bool camera_device_path(char *path, size_t size) {
    unsigned bus = 0, device = 0;
    if (!camera_port || sscanf(camera_port, "usb:%u,%u", &bus, &device) != 2)
        return false;
    return snprintf(path, size, "/dev/bus/usb/%03u/%03u", bus, device) > 0;
}

static bool process_owns_device(long pid, const char *device_path) {
    struct stat device_stat;
    if (stat(device_path, &device_stat) < 0) return false;

    char fd_directory[64];
    snprintf(fd_directory, sizeof fd_directory, "/proc/%ld/fd", pid);
    DIR *fds = opendir(fd_directory);
    if (!fds) return false;

    bool owns_device = false;
    struct dirent *fd_entry;
    while ((fd_entry = readdir(fds))) {
        if (!numeric_name(fd_entry->d_name)) continue;
        long fd_number = strtol(fd_entry->d_name, NULL, 10);
        char fd_path[96];
        snprintf(fd_path, sizeof fd_path, "%s/%ld", fd_directory, fd_number);
        struct stat fd_stat;
        if (stat(fd_path, &fd_stat) == 0 &&
            fd_stat.st_dev == device_stat.st_dev &&
            fd_stat.st_ino == device_stat.st_ino &&
            fd_stat.st_rdev == device_stat.st_rdev) {
            owns_device = true;
            break;
        }
    }
    closedir(fds);
    return owns_device;
}

/* Report the same-user process holding the usbfs node. This turns libgphoto2's
 * generic claim error into an actionable message for the Shell extension. */
static bool report_device_blocker(void) {
    char device_path[64];
    if (!camera_device_path(device_path, sizeof device_path)) return false;

    DIR *proc = opendir("/proc");
    if (!proc) return false;

    struct dirent *process_entry;
    while ((process_entry = readdir(proc))) {
        if (!numeric_name(process_entry->d_name))
            continue;
        long pid = strtol(process_entry->d_name, NULL, 10);
        if (pid == (long)getpid()) continue;

        if (!process_owns_device(pid, device_path)) continue;

        char comm_path[64], process[64] = "unknown";
        snprintf(comm_path, sizeof comm_path, "/proc/%ld/comm", pid);
        FILE *comm = fopen(comm_path, "r");
        if (comm) {
            if (fgets(process, sizeof process, comm))
                process[strcspn(process, "\r\n")] = '\0';
            fclose(comm);
        }
        sanitize_process_name(process);
        log_msg("error", "event=device-blocked device=%s pid=%ld process=%s",
                device_path, pid, process);
        closedir(proc);
        return true;
    }

    closedir(proc);
    return false;
}

static bool likely_exclusive_access_error(int rc) {
    return rc == GP_ERROR_IO_USB_CLAIM || rc == GP_ERROR_IO_LOCK ||
           rc == GP_ERROR_CAMERA_BUSY;
}

static int release_device_blocker(long pid) {
    char device_path[64], proc_path[64];
    if (pid <= 1 || !camera_device_path(device_path, sizeof device_path)) {
        log_msg("error", "event=release-blocker result=invalid-request");
        return 2;
    }

    snprintf(proc_path, sizeof proc_path, "/proc/%ld", pid);
    struct stat process_stat;
    if (stat(proc_path, &process_stat) < 0 || process_stat.st_uid != getuid()) {
        log_msg("error", "event=release-blocker result=wrong-owner pid=%ld", pid);
        return 1;
    }
    if (!process_owns_device(pid, device_path)) {
        log_msg("error", "event=release-blocker result=no-longer-blocking pid=%ld device=%s",
                pid, device_path);
        return 1;
    }
    if (kill((pid_t)pid, SIGTERM) < 0) {
        log_msg("error", "event=release-blocker result=signal-failed pid=%ld error=%s",
                pid, strerror(errno));
        return 1;
    }
    log_msg("info", "event=release-blocker result=terminated pid=%ld device=%s",
            pid, device_path);
    return 0;
}

static CameraWidget *find_widget(CameraWidget *root, const char *name) {
    CameraWidget *found = NULL;
    if (gp_widget_get_child_by_name(root, name, &found) >= GP_OK) return found;
    if (gp_widget_get_child_by_label(root, name, &found) >= GP_OK) return found;
    int count = gp_widget_count_children(root);
    for (int i = 0; i < count; i++) {
        CameraWidget *child = NULL;
        if (gp_widget_get_child(root, i, &child) >= GP_OK && (found = find_widget(child, name))) return found;
    }
    return NULL;
}

static int set_config(Camera *camera, GPContext *context, const char *name, int value, bool optional) {
    CameraWidget *config = NULL;
    int rc = gp_camera_get_config(camera, &config, context);
    if (rc < GP_OK) return rc;
    CameraWidget *widget = find_widget(config, name);
    if (!widget) {
        gp_widget_free(config);
        if (!optional) log_msg("error", "event=config-missing key=%s", name);
        return GP_ERROR_NOT_SUPPORTED;
    }
    CameraWidgetType type; gp_widget_get_type(widget, &type);
    if (type == GP_WIDGET_TOGGLE) rc = gp_widget_set_value(widget, &value);
    else if (type == GP_WIDGET_MENU || type == GP_WIDGET_RADIO) {
        const char *choice = value ? "1" : "0"; rc = gp_widget_set_value(widget, choice);
    } else rc = GP_ERROR_NOT_SUPPORTED;
    if (rc >= GP_OK) rc = gp_camera_set_config(camera, config, context);
    gp_widget_free(config);
    if (rc >= GP_OK) log_msg("info", "event=config-set key=%s value=%d", name, value);
    else if (!optional) log_msg("error", "event=config-failed key=%s error=%s", name, gp_result_as_string(rc));
    return rc;
}

static int set_config_choice(Camera *camera, GPContext *context, const char *name,
                             const char *preferred, const char *fallback) {
    CameraWidget *config = NULL;
    int rc = gp_camera_get_config(camera, &config, context);
    if (rc < GP_OK) return rc;

    CameraWidget *widget = find_widget(config, name);
    if (!widget) {
        gp_widget_free(config);
        log_msg("warning", "event=config-missing key=%s", name);
        return GP_ERROR_NOT_SUPPORTED;
    }

    CameraWidgetType type;
    gp_widget_get_type(widget, &type);
    if (type != GP_WIDGET_MENU && type != GP_WIDGET_RADIO) {
        gp_widget_free(config);
        log_msg("warning", "event=config-failed key=%s reason=wrong-widget-type", name);
        return GP_ERROR_NOT_SUPPORTED;
    }

    const char *selected = NULL;
    int count = gp_widget_count_choices(widget);
    for (int i = 0; i < count; i++) {
        const char *choice = NULL;
        if (gp_widget_get_choice(widget, i, &choice) < GP_OK || !choice) continue;
        log_msg("debug", "event=config-choice key=%s value=\"%s\"", name, choice);
        if (!strcmp(choice, preferred)) selected = choice;
        else if (!selected && fallback && !strcmp(choice, fallback)) selected = choice;
    }

    if (!selected) {
        gp_widget_free(config);
        log_msg("warning", "event=config-failed key=%s reason=hdmi-output-unavailable", name);
        return GP_ERROR_NOT_SUPPORTED;
    }

    rc = gp_widget_set_value(widget, selected);
    if (rc >= GP_OK) rc = gp_camera_set_config(camera, config, context);
    if (rc >= GP_OK)
        log_msg("info", "event=config-set key=%s value=\"%s\"", name, selected);
    else
        log_msg("warning", "event=config-failed key=%s error=%s", name, gp_result_as_string(rc));
    gp_widget_free(config);
    return rc;
}

static int open_live_view(Camera *camera, GPContext *context) {
    int rc = set_config(camera, context, "viewfinder", 1, true);
    if (rc == GP_ERROR_NOT_SUPPORTED) rc = set_config(camera, context, "eosviewfinder", 1, false);
    if (rc >= GP_OK) {
        /* Canon's remote-EVF fallback selects output bit 2 (PC), which can
         * blank HDMI capture. Restore the display path after opening Live
         * View: bit 1 is TFT and bit 3 is TFT + PC. On bodies that expose
         * only TFT, an attached HDMI monitor/capture device receives that
         * display path in place of the camera LCD. */
        int output_rc = set_config_choice(camera, context, "output", "TFT + PC", "TFT");
        log_msg(output_rc >= GP_OK ? "info" : "warning",
                "event=live-view-output mode=hdmi result=%s", gp_result_as_string(output_rc));
        log_msg("info", "event=live-view state=open");
    }
    return rc;
}

static void close_live_view(Camera *camera, GPContext *context) {
    int rc = set_config(camera, context, "viewfinder", 0, true);
    if (rc == GP_ERROR_NOT_SUPPORTED) rc = set_config(camera, context, "eosviewfinder", 0, true);
    log_msg(rc >= GP_OK ? "info" : "warning", "event=live-view state=closed result=%s", gp_result_as_string(rc));
}

static int configure_selected_camera(Camera *camera, GPContext *context) {
    if (!camera_port || !*camera_port) return GP_OK;
    CameraAbilitiesList *abilities = NULL;
    GPPortInfoList *ports = NULL;
    int rc = gp_abilities_list_new(&abilities);
    if (rc < GP_OK) return rc;
    rc = gp_abilities_list_load(abilities, context);
    if (rc < GP_OK) goto done;
    rc = gp_port_info_list_new(&ports);
    if (rc < GP_OK) goto done;
    rc = gp_port_info_list_load(ports);
    if (rc < GP_OK) goto done;
    int port_index = gp_port_info_list_lookup_path(ports, camera_port);
    int ability_index = camera_model ? gp_abilities_list_lookup_model(abilities, camera_model) : GP_ERROR_BAD_PARAMETERS;
    if (port_index < GP_OK || ability_index < GP_OK) {
        rc = GP_ERROR_UNKNOWN_PORT;
        goto done;
    }
    GPPortInfo port_info;
    CameraAbilities camera_abilities;
    rc = gp_port_info_list_get_info(ports, port_index, &port_info);
    if (rc >= GP_OK) rc = gp_abilities_list_get_abilities(abilities, ability_index, &camera_abilities);
    if (rc >= GP_OK) rc = gp_camera_set_port_info(camera, port_info);
    if (rc >= GP_OK) rc = gp_camera_set_abilities(camera, camera_abilities);
done:
    if (ports) gp_port_info_list_free(ports);
    gp_abilities_list_free(abilities);
    return rc;
}

static int connect_camera(Camera **out, GPContext *context) {
    Camera *camera = NULL; int rc = gp_camera_new(&camera);
    if (rc < GP_OK) return rc;
    log_msg("info", "event=connect-attempt model=\"%s\" port=%s",
            camera_model ? camera_model : "automatic", camera_port ? camera_port : "automatic");
    rc = configure_selected_camera(camera, context);
    if (rc < GP_OK) {
        log_msg("error", "event=selection-failed error=%s", gp_result_as_string(rc));
        gp_camera_free(camera);
        return rc;
    }
    rc = gp_camera_init(camera, context);
    if (rc < GP_OK) {
        log_msg("error", "event=connect-failed code=%d error=%s",
                rc, gp_result_as_string(rc));
        /* libgphoto2 backends do not consistently map exclusive-access
         * failures to GP_ERROR_IO_USB_CLAIM. Inspect the selected usbfs node
         * after every failed initialization and report only a verified owner. */
        if (!report_device_blocker() && likely_exclusive_access_error(rc))
            log_msg("error", "event=device-blocked device=unknown pid=0 process=unknown");
        gp_camera_free(camera);
        return rc;
    }
    log_msg("info", "event=connected model=\"%s\" port=%s",
            camera_model ? camera_model : "automatic", camera_port ? camera_port : "automatic");
    *out = camera;
    return GP_OK;
}

static int keepalive(Camera *camera, GPContext *context) {
    CameraEventType event_type; void *event_data = NULL;
    int rc = gp_camera_wait_for_event(camera, 100, &event_type, &event_data, context);
    if (event_data) free(event_data);
    if (rc < GP_OK) return rc;
    /* The ptp2 backend performs Canon EOS KeepDeviceOn while polling events.
     * Do not reassert remote viewfinder mode here: that operation can route
     * EVF exclusively to the PC and blank the camera's HDMI display path. */
    log_msg("info", "event=keepalive result=ok camera_event=%d", event_type);
    return GP_OK;
}

static void usage(FILE *stream) {
    fprintf(stream, "Usage: shutterguard-helper [--frequency SECONDS] [--camera-model MODEL --camera-port PORT] [--verbose]\n"
                    "       shutterguard-helper --list-cameras\n"
                    "       shutterguard-helper --release-blocker PID --camera-port PORT\n");
}

static void print_field(const char *value) {
    for (const unsigned char *p = (const unsigned char *)value; *p; p++)
        fputc((*p == '\t' || *p == '\n' || *p == '\r') ? ' ' : *p, stdout);
}

static int list_cameras(GPContext *context) {
    CameraAbilitiesList *abilities = NULL;
    GPPortInfoList *ports = NULL;
    CameraList *cameras = NULL;
    int rc = gp_abilities_list_new(&abilities);
    if (rc >= GP_OK) rc = gp_abilities_list_load(abilities, context);
    if (rc >= GP_OK) rc = gp_port_info_list_new(&ports);
    if (rc >= GP_OK) rc = gp_port_info_list_load(ports);
    if (rc >= GP_OK) rc = gp_list_new(&cameras);
    if (rc >= GP_OK) rc = gp_abilities_list_detect(abilities, ports, cameras, context);
    if (rc >= GP_OK) {
        int count = gp_list_count(cameras);
        for (int i = 0; i < count; i++) {
            const char *model = NULL, *port = NULL;
            if (gp_list_get_name(cameras, i, &model) >= GP_OK &&
                gp_list_get_value(cameras, i, &port) >= GP_OK) {
                fputs("CAMERA\t", stdout); print_field(port);
                fputc('\t', stdout); print_field(model); fputc('\n', stdout);
            }
        }
        fflush(stdout);
    }
    if (cameras) gp_list_free(cameras);
    if (ports) gp_port_info_list_free(ports);
    if (abilities) gp_abilities_list_free(abilities);
    return rc;
}

int main(int argc, char **argv) {
    unsigned frequency = 60;
    bool should_list_cameras = false;
    long blocker_pid = 0;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--verbose")) verbose = 1;
        else if (!strcmp(argv[i], "--list-cameras")) should_list_cameras = true;
        else if (!strcmp(argv[i], "--release-blocker") && i + 1 < argc) {
            char *end = NULL; errno = 0; long value = strtol(argv[++i], &end, 10);
            if (errno || !end || *end || value <= 1) { usage(stderr); return 2; }
            blocker_pid = value;
        }
        else if (!strcmp(argv[i], "--camera-model") && i + 1 < argc) camera_model = argv[++i];
        else if (!strcmp(argv[i], "--camera-port") && i + 1 < argc) camera_port = argv[++i];
        else if (!strcmp(argv[i], "--frequency") && i + 1 < argc) {
            char *end = NULL; errno = 0; unsigned long value = strtoul(argv[++i], &end, 10);
            if (errno || !end || *end || value < 10 || value > 300) { usage(stderr); return 2; }
            frequency = (unsigned)value;
        } else if (!strcmp(argv[i], "--help")) { usage(stdout); return 0; }
        else { usage(stderr); return 2; }
    }
    signal(SIGINT, on_signal); signal(SIGTERM, on_signal);
    if (blocker_pid) return release_device_blocker(blocker_pid);
    GPContext *context = gp_context_new();
    gp_context_set_error_func(context, context_error, NULL);
    gp_context_set_status_func(context, context_status, NULL);
    if (should_list_cameras) {
        int rc = list_cameras(context);
        gp_context_unref(context);
        return rc < GP_OK ? 1 : 0;
    }
    Camera *camera = NULL; unsigned backoff = 1;
    log_msg("info", "event=started frequency=%u", frequency);
    while (running) {
        if (!camera) {
            if (connect_camera(&camera, context) < GP_OK) {
                log_msg("info", "event=reconnect-wait seconds=%u", backoff);
                for (unsigned i = 0; running && i < backoff * 10; i++) usleep(100000);
                if (backoff < 30) backoff *= 2;
                if (backoff > 30) backoff = 30;
                continue;
            }
            backoff = 1;
            if (open_live_view(camera, context) < GP_OK) {
                gp_camera_exit(camera, context); gp_camera_free(camera); camera = NULL; continue;
            }
        }
        for (unsigned elapsed = 0; running && elapsed < frequency * 10; elapsed++) usleep(100000);
        if (running && keepalive(camera, context) < GP_OK) {
            log_msg("warning", "event=session-lost action=reconnect");
            gp_camera_exit(camera, context); gp_camera_free(camera); camera = NULL;
        }
    }
    if (camera) { close_live_view(camera, context); gp_camera_exit(camera, context); gp_camera_free(camera); }
    gp_context_unref(context); log_msg("info", "event=stopped"); return 0;
}
