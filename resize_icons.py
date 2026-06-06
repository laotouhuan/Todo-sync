import os
from PIL import Image

# Config
source_image_path = r"C:/Users/91943/.gemini/antigravity/brain/725a5993-b114-4b7b-96de-bb988c756359/todo_icon_cropped.png"
android_res_dir = r"C:/Users/91943/Desktop/project/to-do list/android/app/src/main/res"
tauri_icons_dir = r"C:/Users/91943/Desktop/project/to-do list/windows/src-tauri/icons"

# Android mipmap sizes
android_sizes = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}

# Tauri icon sizes
tauri_sizes = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 1024,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50
}

def resize_image(img, size, path):
    resized = img.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(path)

def process_android_icons(img):
    for folder, size in android_sizes.items():
        folder_path = os.path.join(android_res_dir, folder)
        os.makedirs(folder_path, exist_ok=True)
        # Save standard
        resize_image(img, size, os.path.join(folder_path, "ic_launcher.png"))
        # Save round (using same for now)
        resize_image(img, size, os.path.join(folder_path, "ic_launcher_round.png"))
    print("Android icons processed.")

def process_tauri_icons(img):
    os.makedirs(tauri_icons_dir, exist_ok=True)
    for filename, size in tauri_sizes.items():
        resize_image(img, size, os.path.join(tauri_icons_dir, filename))
    
    # Generate ICO with multiple sizes for Windows Explorer compatibility
    img.save(os.path.join(tauri_icons_dir, "icon.ico"), format="ICO", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    
    # Generate ICNS
    img_1024 = img.resize((1024, 1024), Image.Resampling.LANCZOS)
    try:
        img_1024.save(os.path.join(tauri_icons_dir, "icon.icns"), format="ICNS")
    except Exception as e:
        print(f"Failed to generate ICNS, but it's okay for Windows: {e}")

    print("Tauri icons processed.")

if __name__ == "__main__":
    if not os.path.exists(source_image_path):
        print(f"Error: Source image {source_image_path} not found.")
        exit(1)
        
    img = Image.open(source_image_path).convert("RGBA")
    process_android_icons(img)
    process_tauri_icons(img)
    print("All icons successfully generated and saved!")
