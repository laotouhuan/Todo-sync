from rembg import remove
from PIL import Image

input_path = "C:/Users/91943/.gemini/antigravity/brain/725a5993-b114-4b7b-96de-bb988c756359/todo_icon_new_clay_1780654048657.png"
output_path = "C:/Users/91943/.gemini/antigravity/brain/725a5993-b114-4b7b-96de-bb988c756359/todo_icon_cropped.png"

def process_with_rembg():
    print("Loading image...")
    input_img = Image.open(input_path).convert("RGBA")
    
    print("Removing background with rembg...")
    # remove() will intelligently strip out the background
    output_img = remove(input_img)
    
    print("Cropping and padding...")
    bbox = output_img.getbbox()
    if bbox:
        cropped_img = output_img.crop(bbox)
        
        # Make a new square transparent image
        max_dim = max(cropped_img.size)
        padding = int(max_dim * 0.02) # slight padding
        new_size = max_dim + 2 * padding
        
        new_img = Image.new("RGBA", (new_size, new_size), (0, 0, 0, 0))
        offset_x = (new_size - cropped_img.width) // 2
        offset_y = (new_size - cropped_img.height) // 2
        new_img.paste(cropped_img, (offset_x, offset_y))
        
        new_img.save(output_path)
        print("Successfully processed image with rembg!")
    else:
        print("Could not find bounding box.")

if __name__ == "__main__":
    process_with_rembg()
