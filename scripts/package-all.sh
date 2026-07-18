#!/usr/bin/env bash
set -Eeuo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(tr -d '[:space:]' < "$project_dir/VERSION")"
release_root="$project_dir/build/release"
extension_stage="$release_root/extension"
rpm_topdir="$release_root/rpmbuild"
source_name="shutterguard-helper-$version"

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "VERSION must contain a semantic version (found: $version)" >&2
    exit 1
fi
if ! grep -Fq "\"version-name\": \"$version\"" "$project_dir/metadata.json"; then
    echo "metadata.json version-name does not match VERSION ($version)" >&2
    exit 1
fi

echo "[release] building ShutterGuard $version"
cd "$project_dir"
make clean
make all

rm -rf -- "$release_root"
mkdir -p "$extension_stage/schemas" "$rpm_topdir/BUILD" \
    "$rpm_topdir/BUILDROOT" "$rpm_topdir/RPMS" "$rpm_topdir/SOURCES" \
    "$rpm_topdir/SPECS" "$rpm_topdir/SRPMS" "$rpm_topdir/tmp" "$project_dir/dist"

# Replace only this version's outputs. Preserve all other versioned release files.
rm -f -- "$project_dir/dist/shutterguard-extension-$version.zip"
find "$project_dir/dist" -maxdepth 1 -type f \
    -name "shutterguard-helper-$version-*.rpm" -delete

echo '[release] creating extension ZIP (native helper intentionally excluded)'
cp metadata.json stylesheet.css build/compiled/extension.js \
    build/compiled/prefs.js "$extension_stage/"
cp LICENSE AUTHORS "$extension_stage/"
cp schemas/*.xml "$extension_stage/schemas/"
(cd "$extension_stage" && zip -qr \
    "$project_dir/dist/shutterguard-extension-$version.zip" .)

echo '[release] creating RPM source archive'
mkdir -p "$release_root/$source_name/backend"
cp backend/shutterguard-helper.c "$release_root/$source_name/backend/"
cp LICENSE AUTHORS README.md "$release_root/$source_name/"
tar -C "$release_root" -czf "$rpm_topdir/SOURCES/$source_name.tar.gz" "$source_name"
sed "s/@VERSION@/$version/g" packaging/rpm/shutterguard-helper.spec.in \
    > "$rpm_topdir/SPECS/shutterguard-helper.spec"

echo '[release] building helper RPM'
rpmbuild -bs --define "_topdir $rpm_topdir" --define "_tmppath $rpm_topdir/tmp" \
    "$rpm_topdir/SPECS/shutterguard-helper.spec"
rpmbuild -bb --define "_topdir $rpm_topdir" --define "_tmppath $rpm_topdir/tmp" \
    "$rpm_topdir/SPECS/shutterguard-helper.spec"
find "$rpm_topdir/RPMS" -type f -name "shutterguard-helper-$version-*.rpm" \
    -exec cp -t "$project_dir/dist" {} +
find "$rpm_topdir/SRPMS" -type f -name "shutterguard-helper-$version-*.src.rpm" \
    -exec cp -t "$project_dir/dist" {} +

extension_zip="$project_dir/dist/shutterguard-extension-$version.zip"
if unzip -Z1 "$extension_zip" | grep -Eq '(^|/)(bin|shutterguard-helper|\.dev-helper-path)(/|$)'; then
    echo '[release] extension ZIP unexpectedly contains native/development files' >&2
    exit 1
fi
if unzip -Z1 "$extension_zip" | grep -Fqx 'schemas/gschemas.compiled'; then
    echo '[release] extension ZIP unexpectedly contains a compiled GSettings schema' >&2
    exit 1
fi
if ! unzip -Z1 "$extension_zip" | grep -Fqx \
    'schemas/org.gnome.shell.extensions.shutterguard.gschema.xml'; then
    echo '[release] extension ZIP is missing its GSettings schema source' >&2
    exit 1
fi

echo '[release] artifacts:'
find "$project_dir/dist" -maxdepth 1 -type f \
    \( -name "*-$version*.zip" -o -name "*-$version-*.rpm" \) -printf '  %f\n'
