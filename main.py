import os
import json
import hashlib
from mutagen.mp3 import MP3
from mutagen.id3 import ID3, APIC
from mutagen.flac import FLAC
from http.server import SimpleHTTPRequestHandler, HTTPServer

# --- 配置区 ---
MUSIC_DIR = "./music"          # 你的音乐文件夹路径（支持 mp3 和 flac）
OUTPUT_DIR = "./data"          # json 和 提取出的封面 存放路径
COVERS_DIR = os.path.join(OUTPUT_DIR, "covers")
ALBUMS_DIR = os.path.join(OUTPUT_DIR, "albums")
HTTP_HOST = "0.0.0.0"
HTTP_PORT = 8002

# 初始化输出目录
os.makedirs(COVERS_DIR, exist_ok=True)
os.makedirs(ALBUMS_DIR, exist_ok=True)

def generate_album_id(album_name):
    """根据专辑名生成唯一的 ID"""
    return hashlib.md5(album_name.encode('utf-8')).hexdigest()[:8]

def process_music_library():
    albums_summary = []
    
    # 我们假设你的音乐是按文件夹分类的，一个文件夹一张专辑
    for root, dirs, files in os.walk(MUSIC_DIR):
        audio_files = [f for f in files if f.lower().endswith(('.mp3', '.flac'))]
        if not audio_files:
            continue

        album_name = os.path.basename(root)
        album_id = generate_album_id(album_name)
        album_artist = "Unknown Artist"
        cover_path = ""

        tracks = []

        # 遍历该专辑下的所有音频文件
        for file in audio_files:
            file_path = os.path.join(root, file)
            # 为了在网页中引用，统一转换为正斜杠的相对路径
            web_file_url = "./" + file_path.replace("\\", "/").lstrip("./")
            is_flac = file.lower().endswith('.flac')

            try:
                if is_flac:
                    audio = FLAC(file_path)

                    # FLAC 使用 Vorbis Comment，标签值为列表
                    title = audio.get('title', [file[:-5]])[0]
                    artist = audio.get('artist', ['Unknown'])[0]
                    album_artist_tag = audio.get('albumartist', [artist])[0]
                    if album_artist == "Unknown Artist":
                        album_artist = album_artist_tag

                    track_tag = audio.get('tracknumber', ['99'])[0]
                    track_num = int(track_tag.split('/')[0]) if track_tag.split('/')[0].isdigit() else 99

                    duration = audio.info.length

                    # 提取封面 (FLAC 封面存储在 audio.pictures 列表中)
                    if not cover_path and audio.pictures:
                        pic = audio.pictures[0]
                        cover_ext = ".png" if pic.mime == "image/png" else ".jpg"
                        cover_filename = f"{album_id}{cover_ext}"
                        cover_local_path = os.path.join(COVERS_DIR, cover_filename)
                        with open(cover_local_path, "wb") as img:
                            img.write(pic.data)
                        cover_path = f"./data/covers/{cover_filename}"

                else:
                    audio = MP3(file_path, ID3=ID3)

                    # 读取基础信息 (带有默认值回退)
                    title = str(audio['TIT2']) if 'TIT2' in audio else file[:-4]
                    artist = str(audio['TPE1']) if 'TPE1' in audio else 'Unknown'
                    album_artist_tag = str(audio['TPE2']) if 'TPE2' in audio else artist
                    if album_artist == "Unknown Artist":
                        album_artist = album_artist_tag

                    if 'TRCK' in audio:
                        track_tag = str(audio['TRCK'].text[0])
                        track_num_str = track_tag.split('/')[0]
                        track_num = int(track_num_str) if track_num_str.isdigit() else 99
                    else:
                        track_num = 99

                    duration = audio.info.length

                    # 提取封面 (只在专辑的第一首歌或者还没提取到时进行)
                    if not cover_path:
                        for tag in audio.tags.values():
                            if isinstance(tag, APIC):
                                cover_ext = ".png" if tag.mime == "image/png" else ".jpg"
                                cover_filename = f"{album_id}{cover_ext}"
                                cover_local_path = os.path.join(COVERS_DIR, cover_filename)

                                with open(cover_local_path, "wb") as img:
                                    img.write(tag.data)

                                cover_path = f"./data/covers/{cover_filename}"
                                break

            except Exception as e:
                print(f"解析 {file} 失败: {e}")
                continue
                
            tracks.append({
                "track_number": track_num,
                "title": title,
                "artist": artist,
                "file_url": web_file_url,
                "duration": round(duration, 3)
            })
            
        # 按音轨号排序，以确保播放顺序和大进度条拼接顺序正确
        tracks.sort(key=lambda x: (x["track_number"], x["file_url"]))
        
        # 排序后，计算 start_time 和 total_duration
        total_duration = 0.0
        for track in tracks:
            track["start_time"] = round(total_duration, 3)
            total_duration += track["duration"]
            
        # 默认封面图处理（如果没有提取到内置封面）
        if not cover_path:
            cover_path = "./assets/default-bg.jpg"
            
        detail_url = f"./data/albums/{album_id}.json"
        
        # 组装完整的单张专辑详情 JSON
        album_detail = {
            "id": album_id,
            "title": album_name,
            "artist": album_artist,
            "cover_url": cover_path,
            "total_duration": round(total_duration, 3),
            "tracks": tracks
        }
        
        # 写入 album_xxx.json
        with open(os.path.join(ALBUMS_DIR, f"{album_id}.json"), 'w', encoding='utf-8') as f:
            json.dump(album_detail, f, ensure_ascii=False, indent=2)
            
        # 将精简信息推入总列表
        albums_summary.append({
            "id": album_id,
            "title": album_name,
            "artist": album_artist,
            "cover_url": cover_path,
            "detail_url": detail_url
        })
        
        print(f"成功处理专辑: {album_name} ({len(tracks)} 首歌曲)")

    # 写入主配置文件 albums.json
    with open(os.path.join(OUTPUT_DIR, "albums.json"), 'w', encoding='utf-8') as f:
        json.dump(albums_summary, f, ensure_ascii=False, indent=2)
        
    print(f"\n全部处理完成！共生成 {len(albums_summary)} 张专辑的数据。")

if __name__ == "__main__":
    # Preprocess
    process_music_library()

    # HTTP Server
    server = HTTPServer((HTTP_HOST, HTTP_PORT), SimpleHTTPRequestHandler)
    print(f"Serving on http://{HTTP_HOST}:{HTTP_PORT}")
    server.serve_forever()
