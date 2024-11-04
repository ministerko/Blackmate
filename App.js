import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  Button,
  Alert,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Platform,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';

// Configuration constants
const API_URL = 'http://192.155.92.17:8080';
const AUTH_TOKEN = 'your_auth_token_here'; // Replace with your actual auth token

const App = () => {
  const [videoUrl, setVideoUrl] = useState('');
  const [mediaType, setMediaType] = useState('audio');
  const [quality, setQuality] = useState('720');
  const [downloadHistory, setDownloadHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [downloadSpeed, setDownloadSpeed] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [currentVideoInfo, setCurrentVideoInfo] = useState(null);

  const handleDownload = async () => {
    if (!videoUrl) {
      Alert.alert('Error', 'Please enter a YouTube URL');
      return;
    }

    setIsLoading(true);
    setProgress(0);

    try {
      // Fetch the file URL from your API with authentication
      const response = await fetch(`${API_URL}/generate-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: AUTH_TOKEN, // Add the auth token header
        },
        body: JSON.stringify({
          url: videoUrl,
          type: mediaType,
          quality: mediaType === 'video' ? quality : null,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to generate download URL');
      }

      const result = await response.json();
      const downloadUrl = result.url.replace('localhost', '192.155.92.17'); // Replace localhost if present
      const filename = result.actual_file_name;
      const fileUri = `${FileSystem.documentDirectory}${filename}`;

      // Set video info if available
      if (result.video_info) {
        setCurrentVideoInfo(result.video_info);
      }

      // Download file with authentication
      const downloadResumable = FileSystem.createDownloadResumable(
        downloadUrl,
        fileUri,
        {
          headers: {
            Authorization: AUTH_TOKEN,
          },
        },
        (downloadProgress) => {
          const progress =
            downloadProgress.totalBytesWritten /
            downloadProgress.totalBytesExpectedToWrite;
          setProgress(progress);

          // Calculate download speed and time remaining
          const bytesWritten = downloadProgress.totalBytesWritten;
          const totalBytes = downloadProgress.totalBytesExpectedToWrite;
          const elapsedTime = Date.now() - downloadStartTime;
          const speed = bytesWritten / (elapsedTime / 1000); // bytes per second
          setDownloadSpeed(speed);

          const remainingBytes = totalBytes - bytesWritten;
          const timeRemaining = remainingBytes / speed;
          setTimeRemaining(Math.round(timeRemaining));
        },
      );

      const downloadStartTime = Date.now();
      const downloadResult = await downloadResumable.downloadAsync();

      if (downloadResult) {
        // Add to download history
        const historyItem = {
          filename: filename,
          size: result.size,
          timestamp: new Date(),
          type: mediaType,
        };
        setDownloadHistory((prev) => [historyItem, ...prev]);

        // Save to media library
        const { status } = await MediaLibrary.requestPermissionsAsync();
        if (status === 'granted') {
          const asset = await MediaLibrary.createAssetAsync(downloadResult.uri);
          await MediaLibrary.createAlbumAsync(
            'Blackmate Downloads',
            asset,
            false,
          );
          Alert.alert('Success', `File saved as ${filename}`);
        } else {
          Alert.alert(
            'Permission Required',
            'Please allow media library permissions',
          );
        }
      } else {
        throw new Error('Download failed');
      }
    } catch (error) {
      Alert.alert('Error', error.message || 'Download failed');
    } finally {
      setIsLoading(false);
      setProgress(0);
      setDownloadSpeed(0);
      setTimeRemaining(0);
    }
  };

  // Rest of your component remains the same...
  return (
    <View style={styles.container}>
      <Text style={styles.title}>YouTube Downloader</Text>
      <TextInput
        style={styles.input}
        placeholder="Enter YouTube URL"
        placeholderTextColor="#666"
        onChangeText={setVideoUrl}
        value={videoUrl}
      />

      {currentVideoInfo && (
        <View style={styles.videoInfoContainer}>
          <Text style={styles.videoTitle}>{currentVideoInfo.title}</Text>
          <Text style={styles.videoDuration}>
            Duration: {currentVideoInfo.duration}
          </Text>
        </View>
      )}

      {mediaType === 'video' && (
        <TextInput
          style={styles.input}
          placeholder="Enter quality (e.g., 720 for 720p)"
          placeholderTextColor="#666"
          onChangeText={setQuality}
          value={quality}
          keyboardType="numeric"
        />
      )}

      <View style={styles.buttonContainer}>
        <Button
          title="Download Audio"
          onPress={() => {
            setMediaType('audio');
            handleDownload();
          }}
          disabled={isLoading}
        />
        <Button
          title="Download Video"
          onPress={() => {
            setMediaType('video');
            handleDownload();
          }}
          disabled={isLoading}
        />
      </View>

      {isLoading && (
        <View style={styles.progressContainer}>
          <ActivityIndicator size="small" color="#9400D3" />
          <View style={styles.progressBarContainer}>
            <View
              style={[styles.progressBar, { width: `${progress * 100}%` }]}
            />
          </View>
          <Text style={styles.progressText}>
            {(progress * 100).toFixed(1)}% Complete
          </Text>
          <Text style={styles.speedText}>
            Speed: {formatBytes(downloadSpeed)}/s
          </Text>
          <Text style={styles.timeText}>
            Time remaining: {formatTime(timeRemaining)}
          </Text>
        </View>
      )}

      <ScrollView style={styles.historyContainer}>
        <Text style={styles.historyTitle}>Download History:</Text>
        {downloadHistory.map((item, index) => (
          <View key={index} style={styles.historyItem}>
            <Text style={styles.historyFilename}>{item.filename}</Text>
            <Text>Size: {formatBytes(item.size)}</Text>
            <Text>Date: {new Date(item.timestamp).toLocaleString()}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
};

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s
      .toString()
      .padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 20,
    color: '#9400D3',
  },
  input: {
    height: 40,
    borderColor: '#ccc',
    borderWidth: 1,
    paddingHorizontal: 10,
    borderRadius: 5,
    marginBottom: 20,
    color: '#333',
  },
  videoInfoContainer: {
    marginBottom: 10,
  },
  videoTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
  },
  videoDuration: {
    fontSize: 14,
    color: '#666',
  },
  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  progressContainer: {
    alignItems: 'center',
    marginVertical: 10,
  },
  progressBarContainer: {
    height: 8,
    width: '100%',
    backgroundColor: '#eee',
    borderRadius: 5,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#9400D3',
  },
  progressText: {
    marginTop: 5,
    color: '#333',
  },
  speedText: {
    color: '#666',
  },
  timeText: {
    color: '#666',
  },
  historyContainer: {
    marginTop: 20,
  },
  historyTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
  },
  historyItem: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#ccc',
  },
  historyFilename: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
  },
});

export default App;
