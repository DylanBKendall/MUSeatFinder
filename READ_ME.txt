# MU Seat Finder

An automated tool to monitor and notify when seats become available in Miami University courses.

## Features
- Monitor multiple course CRNs simultaneously
- Real-time email notifications when seats become available
- Automatic network connectivity checks
- Miami University authentication integration

## Prerequisites
- Node.js (v16 or higher)
- A Miami University email account (@miamioh.edu)
- Connection to Miami University network (either on campus or via VPN)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/[your-username]/MUSeatFinder.git
   ```

2. Navigate to the project directory:
   ```bash
   cd MUSeatFinder
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

## Usage

1. Start the program:
   ```bash
   npm start
   ```

2. Follow the prompts to:
   - Enter your Miami University email
   - Enter the CRNs of courses you want to monitor
   - Receive confirmation email
   - Wait for notifications when seats become available

## Important Notes
- You must use your Miami University email (@miamioh.edu)
- You must be connected to Miami's network or VPN
- The program checks for seats every 2 minutes
- Leave the program running to continue monitoring
- Press Ctrl+C at any time to stop the program

## Network Requirements
The program requires one of the following:
1. Connection to Miami's campus network
2. Connection to Miami's VPN
3. Connection to MU-WIRELESS

## Author
[Dylan Kendall]