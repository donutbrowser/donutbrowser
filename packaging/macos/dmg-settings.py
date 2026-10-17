# dmgbuild settings for the macOS disk image. scripts/build-macos-dmg.sh runs
# dmgbuild with them. dmgbuild writes the .DS_Store directly, so the layout
# needs no Finder session and is the same on every build.
#
# Icon locations are icon centres, in points from the top-left of the window
# content. The window origin is measured from the bottom-left of the screen,
# and its size includes the title bar. Finder on macOS 26 also shows a tab
# bar, which leaves about 362 points of content height. The background is
# drawn for this layout: change dmg-background.svg with it and render it
# again at 1x and 2x.

import os.path

app = defines["app"]
app_name = os.path.basename(app.rstrip("/"))

format = "UDZO"
compression_level = 9
filesystem = "HFS+"

files = [app]
symlinks = {"Applications": "/Applications"}
# No hide_extensions: its Finder flag on the bundle fails codesign --strict.

icon = defines["volume_icon"]
# dmgbuild joins dmg-background@2x.png with it into one HiDPI TIFF.
background = defines["background"]

window_rect = ((400, 400), (660, 430))
default_view = "icon-view"
show_toolbar = False
show_tab_view = False
show_status_bar = False
show_pathbar = False
show_sidebar = False

arrange_by = None
icon_size = 128
text_size = 13
label_pos = "bottom"

icon_locations = {
    app_name: (170, 222),
    "Applications": (490, 222),
}

# Items that Finder shows when hidden files are visible. They sit to the right
# of the window, so they stay out of view.
for i, name in enumerate(
    (".background.tiff", ".VolumeIcon.icns", ".fseventsd", ".Trashes")
):
    icon_locations[name] = (900 + 160 * i, 222)
