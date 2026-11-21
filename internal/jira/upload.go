package jira

import (
	"bytes"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
)

const attachmentField = "file"

// encodeBody returns the wire body and its Content-Type: multipart for uploads, JSON otherwise.
func (request Request) encodeBody() ([]byte, string, error) {
	if len(request.Files) > 0 {
		return encodeMultipart(request.Files)
	}
	body, err := request.JSONBody()
	if err != nil || len(body) == 0 {
		return nil, "", err
	}
	return body, "application/json", nil
}

func encodeMultipart(paths []string) ([]byte, string, error) {
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for _, path := range paths {
		if err := writeFilePart(writer, path); err != nil {
			return nil, "", err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, "", fmt.Errorf("finish multipart body: %w", err)
	}
	return buffer.Bytes(), writer.FormDataContentType(), nil
}

func writeFilePart(writer *multipart.Writer, path string) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open attachment: %w", err)
	}
	defer file.Close()
	part, err := writer.CreateFormFile(attachmentField, filepath.Base(path))
	if err != nil {
		return fmt.Errorf("create multipart part for %s: %w", path, err)
	}
	if _, err := io.Copy(part, file); err != nil {
		return fmt.Errorf("read attachment %s: %w", path, err)
	}
	return nil
}

// ValidateAttachmentFiles checks every path is a readable regular file, so nothing is sent for a bad list.
func ValidateAttachmentFiles(paths []string) error {
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("attachment %s: %w", path, err)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("attachment %s is not a regular file", path)
		}
	}
	return nil
}
