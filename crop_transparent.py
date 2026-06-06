import os
from PIL import Image, ImageChops

source_path = r"C:/Users/91943/.gemini/antigravity/brain/725a5993-b114-4b7b-96de-bb988c756359/todo_icon_new_clay_1780654048657.png"
output_path = r"C:/Users/91943/.gemini/antigravity/brain/725a5993-b114-4b7b-96de-bb988c756359/todo_icon_cropped.png"

def remove_background_and_crop(src, dst, tolerance=50):
    img = Image.open(src).convert("RGBA")
    data = img.getdata()
    
    # Assuming top-left pixel is the background color
    bg_color = data[0]
    
    new_data = []
    for item in data:
        # Check if the pixel is close to the background color
        if abs(item[0] - bg_color[0]) < tolerance and \
           abs(item[1] - bg_color[1]) < tolerance and \
           abs(item[2] - bg_color[2]) < tolerance:
            new_data.append((255, 255, 255, 0)) # Transparent
        else:
            new_data.append(item)
            
    img.putdata(new_data)
    
    # Get bounding box of non-transparent pixels
    bbox = img.getbbox()
    if bbox:
        img_cropped = img.crop(bbox)
        
        # Make a new square transparent image
        max_dim = max(img_cropped.size)
        # Add a little padding (e.g., 5% of max_dim)
        padding = int(max_dim * 0.05)
        new_size = max_dim + 2 * padding
        
        new_img = Image.new("RGBA", (new_size, new_size), (0, 0, 0, 0))
        # Center the cropped image
        offset_x = (new_size - img_cropped.width) // 2
        offset_y = (new_size - img_cropped.height) // 2
        new_img.paste(img_cropped, (offset_x, offset_y))
        
        new_img.save(dst)
        print(f"Successfully processed image and saved to {dst}")
    else:
        print("Could not find bounding box.")

if __name__ == "__main__":
    remove_background_and_crop(source_path, output_path)
