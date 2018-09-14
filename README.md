# Installation

```npm i -g https://github.com/mtwomey/ss.git```

# Usage

## Initial Setup

Before running the setup for ss, you must have the following

* AWS cli tools installed and configured
* Known jump hosts setup in your ~/.ssh/config file
* AWS "Named Profiles" setup for each environment ([see here](https://docs.aws.amazon.com/cli/latest/userguide/cli-multiple-profiles.html))

## Setup ss

`ss --configure`

# Usage and Commands

Set the AWS account you wish to use

`ss --use [AWS NAMED PROFILE NAME]`

Find a resource

`ss --find [INSTANCE/IP/NAME...ETC]`

Connect to a instance found with the --find command

`ss [#]`

Refresh AWS data

`ss --refresh`
