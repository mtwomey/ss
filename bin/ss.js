#! /usr/bin/env node
let tspect = require('tspect');
let taws = require('taws');
let argv = require('yargs').argv;
let fs = require('fs');
let os = require('os');
let ini = require('node-ini');
let readlineSync = require('readline-sync');

let awsConfig, ssConfig, ssCurrentAccount;
function initialize(){
    awsConfig = getAwsConfig();
    ssConfig = getSSConfig();
    ssCurrentAccount = ssConfig.accounts.find(account => {
        if (account.name === ssConfig.currentAccount)
            return true;
    });

    taws.config({
        region: awsConfig[ssConfig.currentAccount].region,
        accessKeyId: awsConfig[ssConfig.currentAccount].aws_access_key_id,
        secretAccessKey: awsConfig[ssConfig.currentAccount].aws_secret_access_key
    });
}

function getAwsConfig(){
    // Combine config and credentials into one object for easier dealing
    let credentials = ini.parseSync(`${os.homedir()}/.aws/credentials`);
    let config = ini.parseSync(`${os.homedir()}/.aws/config`);
    Object.keys(credentials).forEach(key => {
        if (config[`profile ${key}`]) {
            credentials[key].region = config[`profile ${key}`].region;
        }
    });
    return credentials;
}

function getSSConfig(){
    if (fs.existsSync(`${os.homedir()}/.ss`) && fs.existsSync(`${os.homedir()}/.ss/config`)) {
        return JSON.parse(fs.readFileSync(`${os.homedir()}/.ss/config`));
    } else {
        console.log('Run \'ss --configure\' to setup...');
        process.exit();
    }
}

function setupSSConfig(){
    awsConfig = getAwsConfig();
    if (!fs.existsSync(`${os.homedir()}/.ss`)) {
        fs.mkdirSync(`${os.homedir()}/.ss`);
    }

    let config = {};
    config.accounts = [];

    let accounts = Object.keys(awsConfig);
    accounts.forEach(async key => {
        let account = {};
        account.name = key;
        account.jump = readlineSync.question(`Enter Jump Host name / ip for [${key}]: `);
        config.accounts.push(account);
    });
    config.currentAccount = accounts[0];
    fs.writeFileSync(`${os.homedir()}/.ss/config`, JSON.stringify(config, null, 2));
    return config;
}

let ptyProcess;

function awsSSH(proposedLogins, i) { // Can do this with callbacks or promises
    i = i || 0;
    ptyProcess = tspect.spawn('ssh', ['-t', ssCurrentAccount.jump, 'ssh -i', `"${proposedLogins[i].key}" ${proposedLogins[i].username}@${proposedLogins[i].host}`]);
    ptyProcess.expect(['$', '\]#', 'Are you sure you want to continue connecting', 'Please login as the user', 'Permission denied', 'Connection closed', 'password:'], match => {
        if (match === 'Are you sure you want to continue connecting') {
            ptyProcess.write('yes\n');
            awsSSH(proposedLogins, i);
        }
        else if (((match !== '$') && (match !== ']#')) || match == 'password:') {
            ptyProcess.write('~.');
            if (i < proposedLogins.length - 1)
                awsSSH(proposedLogins, i + 1);
        } else {
            ptyProcess.interact();
        }
    })
}

function getAwsData() {
    try {
        awsData = JSON.parse(fs.readFileSync('/tmp/ss.awsData.json'));
        return Promise.resolve(awsData);
    } catch (err) {
        console.log('*** Refreshing AWS Data ***');
        return taws.getAWSInfo()
            .then(awsData => {
                fs.writeFileSync("/tmp/ss.awsData.json", JSON.stringify(awsData, null, 2));
                return Promise.resolve(awsData);
            });
    }
}

function main() {
    processArgv(argv);
    if (argv.configure) {
        setupSSConfig();
        process.exit();
    }
    initialize();
    if (argv.refresh) {
        awsRefresh()
            .then(() => {
                delete argv.refresh;
                main();
            });
    } else if (argv.find) {
        if (argv.asg) {
            getAwsData().then(findAndPrintAutoScalingGroups);
        } else {
            getAwsData().then(findAndPrintInstances);
        }
    } else if (argv.use) {
        switchAccounts(argv.use);
    } else if (argv._.length > 0) {
        getAwsData().then(findAndLogin);
    } else {
        process.exit();
    }
}

function awsRefresh() {
    try {
        fs.unlinkSync('/tmp/ss.awsData.json');
    } catch (err) {
    }
    return getAwsData();
}

function switchAccounts(name) {
    let ssNewAccount = ssConfig.accounts.find(account => {
        return (account.name === name);
    });
    if (!ssNewAccount) {
        console.log('Invalid account.');
    } else {
        ssConfig.currentAccount = name;
        fs.writeFileSync(`${os.homedir()}/.ss/config`, JSON.stringify(ssConfig, null, 2));
        taws.config({
            region: awsConfig[ssConfig.currentAccount].region,
            accessKeyId: awsConfig[ssConfig.currentAccount].aws_access_key_id,
            secretAccessKey: awsConfig[ssConfig.currentAccount].aws_secret_access_key
        });
        awsRefresh();
    }
}

function processArgv(argv) {
    if (typeof argv.refresh === 'string') {
        argv._.push(argv.refresh);
        argv.refresh = true;
    }
    if (typeof argv.asg === 'string') {
        argv._.push(argv.asg);
        argv.asg = true;
    }
    if (typeof argv.configure === 'string') {
        argv._.push(argv.configure);
        argv.configure = true;
    }
}

function findAndPrintAutoScalingGroups(awsData) {
    let autoScalingGroups = findAutoScalingGroupsByString(awsData);
    let n = 1;
    let allFoundInstances = [];
    autoScalingGroups.forEach(autoScalingGroup => {
        let instanceIds = [];
        autoScalingGroup.Instances.forEach(instance => {
            instanceIds.push(instance.InstanceId);
        });
        let instances = taws.getInstancesById(instanceIds, awsData);
        allFoundInstances = allFoundInstances.concat(instances);
        console.log(`*** ${autoScalingGroup.AutoScalingGroupName} ***`);
        instances.forEach(instance => {
            let instanceName;
            instance.Tags.forEach(tag => {
                if (tag.Key === "Name")
                    instanceName = tag.Value;
            });
            console.log(`[${n++}] Name: ${instanceName} InstanceId: ${instance.InstanceId} IP_Address: ${instance.PrivateIpAddress}`);
        });
        console.log();
    });
    fs.writeFileSync("/tmp/ss.instances.json", JSON.stringify(allFoundInstances, null, 2));
    let x = 10;
}

function findAndPrintInstances(awsData) {
    let instances = findInstancesByString(awsData);
    instances.forEach((instance, i) => {
        let instanceName;
        let autoScalingGroupName;
        instance.Tags.forEach(tag => {
            if (tag.Key === "Name")
                instanceName = tag.Value;
            if (tag.Key === "aws:autoscaling:groupName")
                autoScalingGroupName = tag.Value;
        });
        console.log(`[${i + 1}] Name: ${instanceName} InstanceId: ${instance.InstanceId} ASG: ${autoScalingGroupName} IP_Address: ${instance.PrivateIpAddress}`);
    });
    fs.writeFileSync("/tmp/ss.instances.json", JSON.stringify(instances, null, 2));
}

function findAutoScalingGroupsByString(awsData) {
    let targetString = argv.find;
    let autoScalingGroups = [];
    awsData.autoScalingGroups.forEach(autoScalingGroup => {
        let tagName = '';
        autoScalingGroup.Tags.forEach(tag => {
            if (tag.Key === 'Name')
                tagName = tag.Value;
        });
        if (autoScalingGroup.AutoScalingGroupName.indexOf(targetString) !== -1) {
            autoScalingGroups.push(autoScalingGroup);
        } else if (tagName.indexOf(targetString) !== -1) {
            autoScalingGroups.push(autoScalingGroup);
        }

    });
    return autoScalingGroups;
}

function findInstancesByString(awsData) {
    let targetString = argv.find;
    let instances = [];
    for (let i = 0; i < awsData.reservations.length; i++) {
        awsData.reservations[i].Instances.forEach(instance => {
            if (instance.PrivateIpAddress) {
                if (instance.PrivateIpAddress.toLowerCase().indexOf(targetString.toLowerCase()) !== -1)
                    addUnique(instances, instance);
            }
            if (instance.InstanceId) {
                if (instance.InstanceId.toLowerCase().indexOf(targetString.toLowerCase()) !== -1)
                    addUnique(instances, instance);
            }
            instance.Tags.forEach(tag => {
                if (tag.Value.toLowerCase().indexOf(targetString.toLowerCase()) !== -1)
                    addUnique(instances, instance);
            })
        });
    }
    return instances;
}

function findAndLogin(awsData) {
    let targetSystem = argv._[0];
    let instance;
    if (argv._[0].toString().length <= 2) {
        let instances = JSON.parse(fs.readFileSync('/tmp/ss.instances.json'));
        instance = instances[argv._[0] - 1];
    } else {
        for (let i = 0; i < awsData.reservations.length; i++) {
            instance = awsData.reservations[i].Instances.find(instance => {
                return (instance.PrivateIpAddress === targetSystem) || (instance.InstanceId === targetSystem);
            });
            if (instance)
                break;
        }
    }
    awsSSH([
        {key: `${instance.KeyName}.pem`, username: 'ec2-user', host: instance.PrivateIpAddress},
        {key: `${instance.KeyName}.pem`, username: 'ubuntu', host: instance.PrivateIpAddress},
        {key: `${instance.KeyName}.pem`, username: 'root', host: instance.PrivateIpAddress}
    ]);
}

function addUnique(a, o) {
    if (a.indexOf(o) === -1)
        a.push(o)
}

main();
