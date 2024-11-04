package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

var (
	wg            sync.WaitGroup
	downloadMutex sync.Mutex
)

type VideoInfo struct {
	Title       string `json:"title"`
	Duration    string `json:"duration"`
	Thumbnail   string `json:"thumbnail"`
	Description string `json:"description"`
}

type DownloadDetails struct {
	Size           int64     `json:"size"`
	URL            string    `json:"url"`
	ActualFileName string    `json:"actual_file_name"`
	VideoInfo      VideoInfo `json:"video_info"`
}

func sanitizeFilename(filename string) string {
	reg := regexp.MustCompile(`[<>:"/\\|?*]`)
	sanitized := reg.ReplaceAllString(filename, "_")
	sanitized = regexp.MustCompile(`\s+`).ReplaceAllString(sanitized, " ")
	return strings.Trim(sanitized, " .")[:min(len(sanitized), 200)]
}

func getVideoInfo(url string) (VideoInfo, error) {
	cmd := exec.Command("yt-dlp", "--dump-json", "--no-playlist", url)
	output, err := cmd.Output()
	if err != nil {
		return VideoInfo{}, fmt.Errorf("error fetching video info: %v", err)
	}

	var info struct {
		Title       string `json:"title"`
		Duration    int    `json:"duration"`
		Thumbnail   string `json:"thumbnail"`
		Description string `json:"description"`
	}

	if err := json.Unmarshal(output, &info); err != nil {
		return VideoInfo{}, fmt.Errorf("error parsing video info: %v", err)
	}

	duration := formatDuration(info.Duration)
	return VideoInfo{Title: info.Title, Duration: duration, Thumbnail: info.Thumbnail, Description: info.Description}, nil
}

func formatDuration(seconds int) string {
	hours := seconds / 3600
	minutes := (seconds % 3600) / 60
	seconds %= 60
	if hours > 0 {
		return fmt.Sprintf("%02d:%02d:%02d", hours, minutes, seconds)
	}
	return fmt.Sprintf("%02d:%02d", minutes, seconds)
}

func generateDownloadURL(c *gin.Context) {
	var json struct {
		URL     string `json:"url"`
		Type    string `json:"type"`
		Quality string `json:"quality"`
	}

	if err := c.ShouldBindJSON(&json); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid input"})
		return
	}

	if !strings.Contains(json.URL, "youtube.com/") && !strings.Contains(json.URL, "youtu.be/") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid YouTube URL"})
		return
	}

	videoInfo, err := getVideoInfo(json.URL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	userHomeDir, _ := os.UserHomeDir()
	blackMateDir := filepath.Join(userHomeDir, "BlackMate")
	if err := os.MkdirAll(blackMateDir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create BlackMate directory"})
		return
	}

	go cleanupOldFiles(blackMateDir)

	sanitizedTitle := sanitizeFilename(videoInfo.Title)
	extension := "mp4"
	if json.Type == "audio" {
		extension = "mp3"
	}

	timestamp := time.Now().Format("20060102_150405")
	filename := fmt.Sprintf("%s_%s.%s", sanitizedTitle, timestamp, extension)
	filePath := filepath.Join(blackMateDir, filename)

	var downloadCmd *exec.Cmd
	if json.Type == "audio" {
		downloadCmd = exec.Command("yt-dlp", "-f", "bestaudio", "--extract-audio", "--audio-format", "mp3",
			"--newline", "--embed-thumbnail", "--embed-metadata", "-o", filePath, json.URL)
	} else {
		format := "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
		if json.Quality != "" {
			format = fmt.Sprintf("bestvideo[height<=%s][ext=mp4]+bestaudio[ext=m4a]/best[height<=%s][ext=mp4]/best", json.Quality, json.Quality)
		}
		downloadCmd = exec.Command("yt-dlp", "-f", format, "--merge-output-format", "mp4",
			"--newline", "--embed-thumbnail", "--embed-metadata", "-o", filePath, json.URL)
	}

	downloadMutex.Lock()
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer downloadMutex.Unlock()

		stderr, err := downloadCmd.StderrPipe()
		if err != nil {
			log.Println("Failed to create stderr pipe:", err)
			return
		}

		if err := downloadCmd.Start(); err != nil {
			log.Println("Failed to start download:", err)
			return
		}

		go func() {
			buf := make([]byte, 1024)
			for {
				_, err := stderr.Read(buf)
				if err != nil {
					break
				}
			}
		}()

		if err := downloadCmd.Wait(); err != nil {
			log.Println("Failed to download media:", err)
			return
		}

		fileInfo, err := os.Stat(filePath)
		if err != nil {
			log.Println("Unable to get file info:", err)
			return
		}

		downloadURL := fmt.Sprintf("http://%s/download/%s", c.Request.Host, filename)
		c.JSON(http.StatusOK, DownloadDetails{
			Size:           fileInfo.Size(),
			URL:            downloadURL,
			ActualFileName: filename,
			VideoInfo:      videoInfo,
		})

		go func() {
			time.Sleep(5 * time.Minute)
			os.Remove(filePath)
		}()
	}()

	wg.Wait()
}

func cleanupOldFiles(tempDir string) {
	fileExpiration := 5 * time.Minute
	files, err := os.ReadDir(tempDir)
	if err != nil {
		log.Printf("Failed to read directory: %v", err)
		return
	}

	for _, file := range files {
		filePath := filepath.Join(tempDir, file.Name())
		info, err := os.Stat(filePath)
		if err != nil {
			log.Printf("Failed to get file info for %s: %v", filePath, err)
			continue
		}

		if time.Since(info.ModTime()) > fileExpiration {
			if err := os.Remove(filePath); err != nil {
				log.Printf("Failed to delete file %s: %v", filePath, err)
			} else {
				log.Printf("Deleted old file: %s", filePath)
			}
		}
	}
}

func serveFile(c *gin.Context) {
	fileName := c.Param("fileName")
	// Updated path to BlackMate directory instead of Temp
	userHomeDir, _ := os.UserHomeDir()
	blackMateDir := filepath.Join(userHomeDir, "BlackMate")
	filePath := filepath.Join(blackMateDir, fileName)

	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	// Set proper content type
	if strings.HasSuffix(fileName, ".mp3") {
		c.Header("Content-Type", "audio/mpeg")
	} else if strings.HasSuffix(fileName, ".mp4") {
		c.Header("Content-Type", "video/mp4")
	}

	c.Header("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, fileName))
	c.File(filePath)
}


func main() {
	gin.SetMode(gin.ReleaseMode)
	r := gin.Default()

	r.MaxMultipartMemory = 8 << 20
	r.POST("/generate-url", generateDownloadURL)
	r.GET("/download/:fileName", serveFile)

	r.Use(func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	r.Run("192.168.226.71:8080")
}
