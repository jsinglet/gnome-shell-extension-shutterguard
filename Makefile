UUID := shutterguard@singletonmail.com
BUILD := build
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
CFLAGS ?= -O2 -g -Wall -Wextra -Wpedantic
GPHOTO_CFLAGS := $(shell pkg-config --cflags libgphoto2 2>/dev/null)
GPHOTO_LIBS := $(shell pkg-config --libs libgphoto2 2>/dev/null)

.PHONY: all extension helper schemas install install-dev uninstall package clean clean-dist check
all: extension helper schemas

extension:
	@test -x node_modules/.bin/tsc || { echo "Run 'npm install' first"; exit 1; }
	npm run build

helper: $(BUILD)/bin/shutterguard-helper
$(BUILD)/bin/shutterguard-helper: backend/shutterguard-helper.c
	@mkdir -p $(BUILD)/bin
	@pkg-config --exists libgphoto2 || { echo "libgphoto2 development files are required"; exit 1; }
	$(CC) $(CFLAGS) $(GPHOTO_CFLAGS) $< -o $@ $(GPHOTO_LIBS)

schemas: $(BUILD)/schemas/gschemas.compiled
$(BUILD)/schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.shutterguard.gschema.xml
	@mkdir -p $(BUILD)/schemas
	cp $< $(BUILD)/schemas/
	glib-compile-schemas $(BUILD)/schemas

install: extension schemas
	mkdir -p $(DEST)/schemas
	rm -rf $(DEST)/bin
	cp metadata.json stylesheet.css $(BUILD)/compiled/extension.js $(BUILD)/compiled/prefs.js $(DEST)/
	cp schemas/*.xml $(BUILD)/schemas/gschemas.compiled $(DEST)/schemas/
	rm -f $(DEST)/.dev-helper-path
	@command -v restorecon >/dev/null 2>&1 && restorecon -RF $(DEST) || true

install-dev: all
	mkdir -p $(DEST)/schemas
	rm -rf $(DEST)/bin
	cp metadata.json stylesheet.css $(BUILD)/compiled/extension.js $(BUILD)/compiled/prefs.js $(DEST)/
	cp schemas/*.xml $(BUILD)/schemas/gschemas.compiled $(DEST)/schemas/
	printf '%s\n' '$(abspath $(BUILD)/bin/shutterguard-helper)' > $(DEST)/.dev-helper-path
	@command -v restorecon >/dev/null 2>&1 && restorecon -RF $(DEST) || true

uninstall:
	rm -rf $(DEST)

package:
	./scripts/package-all.sh

check:
	$(CC) -fsyntax-only $(CFLAGS) $(GPHOTO_CFLAGS) backend/shutterguard-helper.c
	glib-compile-schemas --strict --dry-run schemas

clean:
	rm -rf $(BUILD)

# Release artifacts are intentionally versioned. Remove them only when explicitly requested.
clean-dist:
	rm -rf dist
