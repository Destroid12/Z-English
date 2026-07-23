import os
import json
import base64
import requests
import re
from xml.etree import ElementTree

# --- CONFIGURATION ---
# Replace with your Gemini API Key from your database / Apps Script properties
API_KEY = "YOUR_API_KEY_HERE"
MODEL = "gemini-1.5-flash"
PPT_DIR = "test_ppt"
OUTPUT_FILE = "session.json"
# ---------------------

def get_gemini_analysis(base64_img, mime_type="image/png"):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}"
    
    prompt = """
    Analyze this image from an English learning presentation.
    Determine if it is:
    1. A real-world photo, meme, or purely decorative picture.
    2. A list of questions/exercises (often with blanks ____ or numbers).
    3. Normal reading text or paragraphs.
    
    Respond in pure JSON format (no markdown formatting or backticks) with the following structure:
    {
      "type": "image" | "questions" | "text",
      "content": "If type is questions or text, provide the transcribed text here. Preserve newlines. For type image, leave empty."
    }
    """
    
    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {"inline_data": {"mime_type": mime_type, "data": base64_img}}
            ]
        }],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json"
        }
    }
    
    try:
        res = requests.post(url, json=payload)
        res.raise_for_status()
        data = res.json()
        text_response = data['candidates'][0]['content']['parts'][0]['text']
        
        # Clean up any potential markdown formatting from the response
        text_response = text_response.strip()
        if text_response.startswith('```json'):
            text_response = text_response[7:-3]
        elif text_response.startswith('```'):
            text_response = text_response[3:-3]
            
        return json.loads(text_response)
    except Exception as e:
        print(f"Error calling Gemini: {e}")
        if 'res' in locals():
            print(res.text)
        return {"type": "image", "content": ""}

def process_presentation():
    slides_dir = os.path.join(PPT_DIR, "ppt", "slides")
    rels_dir = os.path.join(slides_dir, "_rels")
    media_dir = os.path.join(PPT_DIR, "ppt", "media")
    
    if not os.path.exists(slides_dir):
        print(f"Error: {slides_dir} not found. Please extract the PPTX to test_ppt first.")
        return
        
    session_slides = []
    
    # Process up to 100 slides
    for i in range(1, 100):
        slide_xml_path = os.path.join(slides_dir, f"slide{i}.xml")
        rel_xml_path = os.path.join(rels_dir, f"slide{i}.xml.rels")
        
        if not os.path.exists(slide_xml_path):
            break
            
        print(f"Processing slide {i}...")
        
        # 1. Extract Text from XML
        with open(slide_xml_path, 'r', encoding='utf-8') as f:
            xml_content = f.read()
            
        # Very simple regex to extract text from a:t tags
        texts = re.findall(r'<a:t[^>]*>(.*?)</a:t>', xml_content)
        slide_title = "Slide " + str(i)
        
        elements = []
        
        # Combine text paragraphs
        if texts:
            combined_text = " ".join(texts)
            # Try to figure out a title from the first text chunk
            if len(texts) > 0 and len(texts[0]) > 2:
                slide_title = texts[0]
                
            elements.append({
                "kind": "text",
                "id": f"text_{i}",
                "text": combined_text
            })
            
        # 2. Extract Images via relationships
        if os.path.exists(rel_xml_path):
            with open(rel_xml_path, 'r', encoding='utf-8') as f:
                rel_content = f.read()
                
            # Find targets like Target="../media/image1.png"
            images = re.findall(r'Target="\.\./media/([^"]+)"', rel_content)
            
            for img_idx, img_file in enumerate(images):
                img_path = os.path.join(media_dir, img_file)
                if os.path.exists(img_path):
                    print(f"  Analyzing image: {img_file}")
                    
                    # Read and encode image
                    with open(img_path, "rb") as img_f:
                        base64_data = base64.b64encode(img_f.read()).decode('utf-8')
                        
                    mime = "image/jpeg"
                    if img_file.lower().endswith('.png'):
                        mime = "image/png"
                    elif img_file.lower().endswith('.gif'):
                        mime = "image/gif"
                        
                    # Call Gemini
                    analysis = get_gemini_analysis(base64_data, mime)
                    
                    # Map the AI result to slide elements
                    if analysis.get('type') == 'questions':
                        elements.append({
                            "kind": "question",
                            "id": f"img_q_{i}_{img_idx}",
                            "text": analysis.get('content', '')
                        })
                    elif analysis.get('type') == 'text':
                        elements.append({
                            "kind": "text",
                            "id": f"img_t_{i}_{img_idx}",
                            "text": analysis.get('content', '')
                        })
                    else:
                        # It's an actual image, we will just include its name/path
                        elements.append({
                            "kind": "image",
                            "id": f"img_pic_{i}_{img_idx}",
                            "url": f"/media/{img_file}" # Assuming you upload them later
                        })
                        
        session_slides.append({
            "type": "Content",
            "title": slide_title,
            "elements": elements
        })
        
    # Write the output JSON
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(session_slides, f, indent=2, ensure_ascii=False)
        
    print(f"\nDone! Wrote {len(session_slides)} slides to {OUTPUT_FILE}")

if __name__ == "__main__":
    process_presentation()
