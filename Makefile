BINARY := jira-tools
INSTALL_DIR := $(HOME)/.local/bin

.PHONY: build test vet clean install help

build:
	@go build -o $(BINARY) ./cmd/jira-tools

test:
	@go test ./...

vet:
	@go vet ./...

clean:
	@rm -f $(BINARY)
	@go clean

install: build
	@mkdir -p $(INSTALL_DIR)
	@cp $(BINARY) $(INSTALL_DIR)/$(BINARY)
	@echo "Installed $(INSTALL_DIR)/$(BINARY)"

help:
	@echo "Targets: build test vet clean install help"
